# Agent Architecture

## Roster

| Code | Agent | Produces | Consumes | Permission | Changes sites? |
|---|---|---|---|---|---|
| 00 ORCH | Orchestrator | project_brief, build_plan | everything | AMBER | no |
| 01 | Research & Discovery | research_report | project_brief, client_feedback | GREEN | no |
| 02 | UX & Conversion Architect | site_blueprint | research_report, project_brief, client_feedback | GREEN | no |
| 03 | Creative Director | design_system | site_blueprint, research_report, client_feedback | GREEN | no |
| 04 | SEO & Content Architect | content_pack | site_blueprint, design_system, research_report | GREEN | no |
| 05 | WordPress / Elementor Builder | build_report | build_plan, design_system, content_pack, site_blueprint, qa_report | AMBER | yes (with approval) |
| 06 | QA & Launch Auditor | qa_report | build_report, site_blueprint, design_system, content_pack | GREEN | no |
| 07 | Infrastructure & Deployment | deployment_report | qa_report, build_report | AMBER | yes (with approval) |
| 08 | Intelligence Curator | lesson_candidate | qa_report, client_feedback, build_report, deployment_report, research_report | GREEN | **never** |

Agent 08 does not build. It reviews client feedback, QA defects, successful and failed patterns,
performance and conversion evidence, and **proposes** lesson candidates. Human approval decides what
becomes Agency knowledge (see `INTELLIGENCE-MODEL.md`).

Each agent carries a **provider policy** — `preferred`, `fallbacks[]`, optional `reviewer` — and the
capabilities its jobs need (`text`, `structured_output`, `long_context`, `vision`, `code`, `review`).
Seeded policies (editable on the Agents page):

| Agent | Preferred | Fallback | Reviewer |
|---|---|---|---|
| 00 | Claude | OpenAI | — |
| 01 | Gemini | Claude → OpenAI | — |
| 02 | Claude | OpenAI | Gemini |
| 03 | Claude | OpenAI → Gemini | — |
| 04 | Claude | OpenAI | — |
| 05 | Claude | OpenAI | — |
| 06 | OpenAI | Claude → Gemini | — |
| 07 | Claude | OpenAI | — |
| 08 | Claude | Gemini → OpenAI | — |

The agent is the same agent whichever provider runs it. Reviewer providers are recorded but not
executed in Phase 1.

## Provider independence

```
                 ┌──────────── src/ai ─────────────┐
 AgentJob ──▶ ModelRouter ──▶ AIProvider (interface) ──▶ ClaudeProvider  ─┐
                 │                                    OpenAIProvider  ─┼─ stubs (Phase 1)
                 │                                    GeminiProvider  ─┘
                 └── RouterResult { providerId, response, attempts[] }
```

* `AIProvider`: `id`, `displayName`, `capabilities`, `connected`, `configured?`, `availability()`, `execute(request)`.
* `ProviderRequest` is provider-neutral: assembled system context (agent role + knowledge in force),
  instructions, input artifacts, required output schema (e.g. `site_blueprint@1`), required
  capabilities, permission level, available tool ids.
* `ProviderResponse`: structured `output`, human `summary`, `model`, `usage`, `finishReason`.
* Stub adapters never touch the network. They return a labelled placeholder output so the whole
  job → run → artifact → handoff pipeline is exercisable. `configured` only reports whether an env
  key exists; nothing reads or sends it.

### Routing decision (`ModelRouter.plan / execute`)

1. Sequence = job.preferredProvider, then job.fallbackProviders (deduplicated).
2. Exclude providers not registered, disabled in settings, missing a required capability, or
   reporting themselves unavailable — each exclusion is recorded with its reason.
3. Optional `rank()` hook re-orders survivors (reserved for cost/priority routing).
4. Try in order; first success wins. Every skipped/failed/succeeded attempt is recorded, in policy order.
5. If nothing succeeds: `NoProviderAvailableError` carrying all attempts; the job becomes FAILED.

## AgentJob contract

```
id · projectId · agentId · ticketId? · taskType · instructions
inputArtifactIds[] · availableToolIds[] · requiredOutputSchema ("<artifact_type>@<schemaVersion>")
requiredCapabilities[] · preferredProvider · fallbackProviders[] · permissionLevel
status · outputArtifactId · handoffId · error? · createdAt · updatedAt · startedAt · completedAt
```

Task types: `research · ux_architecture · creative_direction · seo_content · build · qa_audit ·
deployment · curate_lessons · orchestrate` (derived from the agent code unless given).

### Lifecycle

```
QUEUED ──▶ RUNNING ──▶ WAITING_APPROVAL ──▶ COMPLETED
   │          │              │
   │          ├──▶ FAILED ───┼──▶ QUEUED (re-run)      WAITING_APPROVAL ──▶ QUEUED (revision)
   └──────────┴──▶ CANCELLED ┘
```

`JOB_TRANSITIONS` in `src/services/agent-jobs.ts` is the single source of truth; illegal moves throw.

### Runs

Each provider attempt is an `AgentRun`: `jobId, providerId, model, attempt, status
(RUNNING|SUCCEEDED|FAILED|SKIPPED), outputSummary, error, tokens, startedAt, finishedAt`. A job that
fell back has several runs. Runs are shown in the project **Runs** tab and in the ticket drawer.

### What "Run Next Ticket" does now

1. `createJobForTicket`: job for the ticket's agent; inputs = latest artifacts of the types the agent
   consumes; a `Handoff` (ACCEPTED) from the producer of the primary input to this agent.
2. `startJob` → RUNNING; handoff IN_PROGRESS; ticket BUILDING; agent WORKING.
3. `ModelRouter.execute` (stub providers).
4. `applyJobResult`: runs recorded; output artifact created (v1, or v(n+1) superseding the previous
   output for the same ticket); job WAITING_APPROVAL; ticket REVIEW / approval PENDING.
5. Human **Approve** in the ticket drawer → job COMPLETED, artifact FINAL, handoff COMPLETED, task
   knowledge cleared. **Needs revision** → job QUEUED; the next run produces the next version.
6. On provider failure: job FAILED with attempts recorded, ticket BLOCKED with a warning, handoff REJECTED.

## Artifacts

Types: `project_brief · research_report · site_blueprint · design_system · content_pack · build_plan ·
build_report · qa_report · client_feedback · deployment_report · lesson_candidate · other`.

Metadata: `id, projectId, type, title, version, createdByAgentId, createdByProvider, ticketId?, jobId?,
status (DRAFT|FINAL|SUPERSEDED|REJECTED), storageLocation (null = metadata only), schemaVersion,
supersedesArtifactId, summary?, content?, createdAt, updatedAt`.

Versioning: `createArtifactVersion(previousId)` creates v(n+1) pointing back via
`supersedesArtifactId` and marks the previous artifact SUPERSEDED. `latestArtifact(project, type)`
and `artifactLineage(id)` are the read helpers. Versioning from an already-superseded artifact is refused.

## Handoffs

```
01 research_report ─▶ 02 site_blueprint ─▶ 03 design_system ─▶ 04 content_pack ─▶ 05 build_report
                                                            ─▶ 06 qa_report ─▶ 07 deployment_report
                                                            ─▶ 08 lesson_candidate ─▶ 00
```

A `Handoff` records `sourceAgentId, destinationAgentId, inputArtifactIds[], outputArtifactId, jobId,
runId, status (PENDING|ACCEPTED|IN_PROGRESS|COMPLETED|REJECTED|CANCELLED), note`. A handoff completes
only with an output artifact. Agents never converse; the artifact is the message.

## Permission model on jobs

Every job carries `permissionLevel` copied from its agent, and the provider request states it. GREEN
jobs may run without approval; AMBER/RED actions still require the human gates. In Phase 1 the level is
recorded and passed to providers; enforcement on real site actions arrives with the execution plane.

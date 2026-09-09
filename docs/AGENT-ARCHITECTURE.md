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
capabilities its jobs need (`requiredCapabilities`: `text`, `structured_output`, `long_context`,
`vision`, `code`, `review`, plus the CTOS-003 additions `reasoning`, `fast_generation`,
`creative_generation` — see `docs/INTELLIGENCE-MODEL.md` for why none of the three new ones are used
as a hard gate on any seeded agent). Seeded policies (editable on the Agents page):

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

The agent is the same agent whichever provider runs it (see "Agent continuity" below). Reviewer
providers are recorded but not executed yet.

An agent may also carry (CTOS-003 Part I, still optional — only some seeded agents have them):

* `mission` — a one-line "why this agent exists" string, e.g. Agent 02's "Turn business and research
  context into an information architecture and conversion logic a builder can execute without
  guessing."
* `exclusions` — things the agent explicitly must not do, beyond the permission model, e.g. Agent 05's
  `["Never certifies its own visual quality (Agent 03/06 do)", "Never activates a launch itself"]`.
* `defaultPriority` — an `ExecutionPriority` (`QUALITY | BALANCED | COST | SPEED`) used to seed
  `AgentJob.executionPriority` when a job doesn't specify one (`createJob` in
  `src/services/agent-jobs.ts` falls back to `agent.defaultPriority ?? "BALANCED"`). See
  `docs/INTELLIGENCE-MODEL.md` for how the router uses this.
* `instructionPackIds` — ids of APPROVED `Skill` rows (kind `instruction_pack`) this agent's jobs draw
  on, in addition to any skill the agent owns or reviews. See "Instruction packs and skills" below.

## Provider independence

```
                        ┌──────────── src/ai (inside the gateway) ─────────────┐
 ExecutionRequest ──▶ ModelRouter ──▶ AIProvider (interface) ──▶ OpenAIProvider  (live, server-side)
                        │                                        ClaudeProvider  (live, server-side)
                        │                                        GeminiProvider  (live, server-side)
                        └── validate(<type>@<version>) ── RouterResult { providerId, output, attempts[] }
```

* `AIProvider`: `id`, `displayName`, `capabilities`, `connected`, `connectionState`, `availability()`, `execute(request)`.
* `ProviderRequest` = provider-neutral `ExecutionRequest` (agent identity, instructions, input
  artifacts, APPROVED knowledge split by scope, APPROVED `activeSkills`, tools, `<type>@<version>`
  output schema, policy, `executionPriority`, permission level) + assembled `systemContext` +
  `outputJsonSchema`.
* `ProviderResponse`: structured `output`, human `summary`, `model`, `usage`, `finishReason`.
* Stub adapters never touch the network; they return the schema example so the whole job → run →
  artifact → handoff pipeline is exercisable. As of CTOS-003 all three real adapters (OpenAI, Claude,
  Gemini) are live, server-side-only implementations of the same interface — a provider without its
  credential reports itself `not_configured` rather than being a permanent stub. Details:
  `docs/PROVIDER-ADAPTERS.md`.

### Routing decision (`ModelRouter.plan / execute`)

1. Sequence = job.preferredProvider, then job.fallbackProviders (deduplicated).
2. Exclude providers not registered, disabled in settings, missing a required capability, or
   reporting themselves unavailable — each exclusion is recorded with its reason. This is a hard
   gate: `requiredCapabilities` never includes the CTOS-003 preference capabilities
   (`reasoning`/`fast_generation`/`creative_generation`) on any seeded agent.
3. `rankCandidates()` (`src/ai/ranking.ts`) scores the survivors — preferred-provider bonus plus
   capability bonuses keyed by `executionPriority` — and orders them, recording a `reasons[]` list
   for each. See `docs/PROVIDER-ROUTING.md`.
4. Try in ranked order; each answer is validated against the required schema — a refusal or a failed
   validation is a failed attempt and the next provider is tried. Every skipped / failed /
   failed-validation / succeeded attempt is recorded, in policy order, carrying its
   `selectionReason`.
5. If nothing succeeds: `NoProviderAvailableError` carrying all attempts; the job becomes FAILED
   (or FAILED_VALIDATION when only validation failed).

## AgentJob contract

```
id · projectId · agentId · ticketId? · taskType · instructions
inputArtifactIds[] · availableToolIds[] · requiredOutputSchema ("<artifact_type>@<schemaVersion>")
requiredCapabilities[] · preferredProvider · fallbackProviders[] · executionPriority?
permissionLevel · status · outputArtifactId · handoffId · requestedById · error?
createdAt · updatedAt · startedAt · completedAt
```

`executionPriority` is optional; `createJob` sets it to `agent.defaultPriority ?? "BALANCED"` at
creation time, so it is copied truthfully even if the agent's own default later changes.

Execution is requested with the job id only; the gateway builds the provider-neutral
`ExecutionRequest` from server-side truth (`docs/EXECUTION-GATEWAY.md`).

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
(RUNNING|SUCCEEDED|FAILED|FAILED_VALIDATION|SKIPPED), outputSummary, error, errorCategory, validation,
latencyMs, inputTokens, outputTokens, totalTokens?, estimatedCostUsd?, selectionReason?, skillIds?,
startedAt, finishedAt`. A job that fell back has several runs. Runs are shown in the project **Runs**
tab (agent, task, provider, status, duration, attempts, output artifact) and in the ticket drawer's
Execution history section (model, `selectionReason`, `totalTokens`/`estimatedCostUsd`, `skillIds` —
see `docs/EXECUTION-GATEWAY.md`). The gateway also writes one `ExecutionLog` per attempt with the
same optional fields.

## Instruction packs and skills

An agent's execution context can include APPROVED `Skill` rows (see `docs/SKILL-SYSTEM.md`):
`approvedSkillsForAgent(data, agentId, agent.instructionPackIds ?? [])`
(`src/services/skills.ts`) returns every APPROVED skill the agent owns (`ownerAgentIds`), reviews
(`reviewerAgentIds`), or names explicitly in its own `instructionPackIds` — never a DRAFT, CANDIDATE
or DEPRECATED one. `buildExecutionRequestFromData` (`src/services/agent-jobs.ts`) calls this and puts
the result on `ExecutionRequest.activeSkills`; `toProviderRequest` renders it into a labelled
"ACTIVE SKILLS (approved only — v...)" block in `systemContext`, separate from the DOCTRINE/AGENCY
KNOWLEDGE/PROJECT FACTS/TASK CONTEXT sections. `skillProvenance()` turns the active skills into
`"id@version"` strings recorded as `skillIds` on the resulting runs and execution logs.

Two agents are seeded with an instruction pack: Agent 02 (`skill_ux_review_pack`, APPROVED) and
Agent 03 (`skill_ct_visual_design`, still CANDIDATE — so it is *not* yet included in any execution
context) and Agent 05 (`skill_ct_elementor_builder`, also CANDIDATE). See
`docs/CT-VISUAL-DESIGN-SKILL.md` and `docs/CT-ELEMENTOR-BUILDER-SKILL.md`.

### What "Run Next Ticket" does now

1. `createJobForTicket`: job for the ticket's agent (with `requestedById`); inputs = latest artifacts of
   the types the agent consumes; a `Handoff` (ACCEPTED) from the producer of the primary input.
2. Permission pre-check in the store: GREEN starts; AMBER without approval records a PENDING request
   under Approvals; RED without the user's authorization stops with a note. (The gateway re-checks.)
3. `startJob` → RUNNING; handoff IN_PROGRESS; ticket BUILDING; agent WORKING; snapshot persisted.
4. `GatewayClient.execute(jobId)` → server: session, tier, envelope, `ModelRouter` with validation and
   fallback, records committed.
5. `APPLY_EXECUTION` mirrors the records: output artifact (v1, or v(n+1) superseding the previous
   output for the same ticket); job WAITING_APPROVAL; ticket REVIEW / approval PENDING.
6. Human **Approve** in the ticket drawer → job COMPLETED, artifact FINAL, handoff COMPLETED, task
   knowledge cleared. **Needs revision** → job QUEUED; the next run produces the next version (and,
   for AMBER, needs a fresh approval).
7. On failure: job FAILED / FAILED_VALIDATION with attempts recorded, ticket BLOCKED with a warning,
   handoff REJECTED.

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

Every job carries `permissionLevel` copied from its agent; the gateway enforces the higher of that and
the agent's current tier. GREEN runs automatically; AMBER requires an approved `JobApproval` for the
exact action fingerprint by a Production Lead/Admin; RED requires the executing user's own
authorization. Full rules in `docs/AUTH-AND-PERMISSIONS.md`.

## Agent continuity

An agent is the durable unit: code, name, role, tier, knowledge, inputs, handoffs and artifact lineage
all belong to it and live in CT-OS. The provider is chosen per execution by policy and availability and
is recorded on the run and on the artifact (`createdByProvider`) as provenance only. Agent 02 executed
by OpenAI because Claude was down is still Agent 02, working on the same blueprint lineage. This is
asserted by `src/__tests__/gateway.test.ts › agent continuity`.

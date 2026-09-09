# Intelligence Model — memory scopes and learning rules

CT-OS does **not** have unrestricted self-learning. Agents may propose; humans decide what the agency
knows. This document describes the four knowledge scopes, the item model, the rules that enforce
human approval, and the seeded U-Proof lesson candidates — and, as of CTOS-003, how the router weighs
providers once several are available and capable of a job.

## ExecutionPriority and provider capabilities (CTOS-003 Part E/F)

`ProviderCapability` (`src/data/types.ts`) grew from six values to nine:
`text | structured_output | long_context | vision | code | review` (original) plus `reasoning |
fast_generation | creative_generation` (CTOS-003). An `Agent.requiredCapabilities[]` list is a **hard
gate**: `ModelRouter.plan()` excludes any candidate missing one of them before ranking ever runs (see
`docs/PROVIDER-ROUTING.md`).

**The three new capabilities are never used as a `requiredCapabilities` gate on any seeded agent.**
Making them required would have excluded an otherwise-perfectly-capable provider simply because a
deployment hadn't tagged it with that label, and would have broken pre-existing deterministic tests
whose default stub capability sets and fixtures don't declare them. Concretely: Agent 03 (Creative
Director) requires `vision` but **not** `creative_generation`; Agent 08 (Intelligence Curator)
requires `text, structured_output, long_context, review` but **not** `reasoning`. `src/data/seed.ts`
carries a comment directly above each agent's `defaultPriority` explaining this choice.

Instead, an agent expresses the preference through `defaultPriority`, an `ExecutionPriority`:

```ts
type ExecutionPriority = "QUALITY" | "BALANCED" | "COST" | "SPEED";
```

`defaultPriority` seeds `AgentJob.executionPriority` at job creation (`createJob` in
`src/services/agent-jobs.ts`: `input.executionPriority ?? agent.defaultPriority ?? "BALANCED"`), which
flows into `ExecutionRequest.executionPriority` and is what `rankCandidates()` reads. So a QUALITY
agent doesn't require `reasoning` — it merely gets a ranking bonus for candidates that happen to have
it, among those that already satisfy every hard-gated capability. Agent 03 and Agent 08 are both
seeded with `defaultPriority: "QUALITY"`.

## Ranking (`src/ai/ranking.ts`)

`rankCandidates(candidates, request)` is a deterministic, explainable scoring pass over candidates the
router has **already filtered** to have every required capability and report themselves available. It
never introduces a provider the job didn't ask for — it only orders, and explains the order of, the
agent's own preferred + fallback sequence:

* +10 if the candidate is `request.preferredProvider`.
* +2 per capability in `PRIORITY_BONUS_CAPABILITIES[priority]` the candidate has (and that isn't
  already a required capability): `QUALITY → [reasoning, long_context]`, `BALANCED →
  [structured_output]`, `SPEED → [fast_generation]`, `COST → []`.
* Under `COST`/`SPEED` priority only, an illustrative `COST_TIER`/`SPEED_TIER` table
  (`{gemini: 1, openai: 2, claude: 3}` / `{gemini: 1, openai: 1, claude: 2}`) breaks ties — explicitly
  **not** live pricing; see `pricing.ts` below for that.
* Ties keep the caller's original policy order (a stable sort), so with no differentiator at all the
  preferred-then-fallback sequence the agent was configured with is exactly what comes out.

Every candidate accumulates a `reasons: string[]` (e.g. `"preferred provider for this job"`,
`"reasoning capability (favoured by QUALITY priority)"`, `"available"`). `explainSelection(providerId,
ranked)` renders these as `"Selected Claude because: + preferred provider for this job + ... +
available"` — this is the exact string recorded as `selectionReason` on the winning (and every
attempted) `RouterAttempt`, then copied onto `AgentRun.selectionReason` and
`ExecutionLog.selectionReason`. See `docs/PROVIDER-ROUTING.md` for how this fits into the full
routing pipeline, and `docs/PROVIDER-ADAPTERS.md` for the adapters themselves.

## Pricing (`src/ai/pricing.ts`)

Usage recording (`inputTokens`/`outputTokens`/`totalTokens`, provider, model) always happens when a
provider returns usage figures; **cost estimation is a separate, optional step** that stays `null`
whenever the model isn't in `PRICING_TABLE` — CT-OS never guesses a price. `PRICING_TABLE` is a small,
versioned array of `{provider, model, effectiveDate, inputPerMillionUsd, outputPerMillionUsd}` entries,
explicitly illustrative publicly-listed rates as of their `effectiveDate` that "WILL go stale" (the
file's own header comment) — a starting point to keep current operationally, never a billing source of
truth. `findPricing(provider, model, at?)` picks the most recent entry effective at or before `at`
(default now) for an exact model match; `estimateCostUsd(provider, model, usage)` multiplies token
counts by the matched rate, returning `null` when nothing matches. `totalTokensOf(usage)` is
`inputTokens + outputTokens` when at least one is known, else `null`. These three feed
`AgentRun.estimatedCostUsd`/`totalTokens` and `ExecutionLog.usage.estimatedCostUsd`/`totalTokens` —
see `docs/EXECUTION-GATEWAY.md`.

## Scopes

| Scope | Meaning | Who writes | Enters as |
|---|---|---|---|
| DOCTRINE | Permanent Creative Touch rules | Humans only | APPROVED |
| AGENCY | Validated Creative Touch knowledge/patterns | Agents propose, humans approve | CANDIDATE → APPROVED |
| PROJECT | Client/project-specific facts and decisions | Humans (APPROVED) or agents (CANDIDATE) | per writer |
| TASK | Temporary execution context bound to one job | Agents and humans | APPROVED, cleared with the job |

## KnowledgeItem

```
id · scope · category · title · content · evidence[] · confidence (0–1)
status (CANDIDATE | APPROVED | REJECTED | DEPRECATED)
projectId (PROJECT/TASK only) · jobId (TASK only)
proposedByAgentId · reviewedBy (human, never an agent) · reviewedAt · createdAt · updatedAt
```

Categories: `safety · qa · build · wordpress · elementor · design · content · conversion · client ·
process · performance · other`.

## AgentLesson — the learning ledger

Every proposal also writes an `AgentLesson`: `agentId, knowledgeItemId, proposedScope (AGENCY|PROJECT),
sourceArtifactId, sourceJobId, source, status (CANDIDATE|APPROVED|REJECTED), reviewedBy, reviewedAt`.
The lesson content lives in the knowledge item; the ledger records who proposed it, from what
evidence, and what a human decided.

## Rules (enforced in `src/services/knowledge.ts`, mirrored by a DB trigger)

1. `proposeLesson()` — an agent's proposal **always** lands as `CANDIDATE`, whatever is requested.
   Agents may propose AGENCY or PROJECT scope, never DOCTRINE.
2. `createKnowledgeItem(actor, …)`
   * Humans may write any scope; DOCTRINE/AGENCY/PROJECT land APPROVED with the human as reviewer.
   * Agents may write TASK context (APPROVED, bound to a job). Any other scope from an agent is CANDIDATE.
   * Only a human may write DOCTRINE.
3. `reviewKnowledgeItem(reviewer, …)` — the reviewer must be a human (typed and checked at runtime).
   `APPROVED` and `REJECTED` require a CANDIDATE; `DEPRECATED` requires an APPROVED item. Approval may
   narrow scope (an AGENCY proposal approved as PROJECT knowledge for the project it came from).
4. `knowledgeForJob(project, job)` — what a provider sees: only **APPROVED** items — all DOCTRINE and
   AGENCY, this project's PROJECT items, and this job's TASK items. Candidates are never sent.
5. `clearTaskKnowledge(job)` — TASK items are dropped when a job completes, fails or is cancelled.
6. Database: `knowledge_items` has a check constraint tying scope to `project_id`, and a trigger
   refusing any non-CANDIDATE, non-TASK row whose `reviewed_by` is null or starts with `agent`.

## Agent 08 — Intelligence Curator

Agent 08 consumes `qa_report`, `client_feedback`, `build_report`, `deployment_report` and
`research_report`, and produces a `lesson_candidate` artifact. Each lesson in that artifact becomes a
CANDIDATE knowledge item plus a ledger entry through `proposeLesson()`. Agent 08 has no path to approve
anything, and `canExecuteSiteChanges` is false.

## Human review (Knowledge screen)

`/knowledge` lists items by scope. For a CANDIDATE: **Approve as Agency knowledge**, **Approve for
project only**, or **Reject**. For APPROVED non-doctrine items: **Deprecate**. Every decision records the
reviewer (`reviewedBy` + `reviewedById` from the signed-in user; VIEWERs cannot decide) and writes an
activity event carrying the actor id.
The sidebar and Overview show how many candidates await review.

## Seeded DOCTRINE (APPROVED — these rules were already in force in the MVP)

* Every build passes through the safety pipeline.
* GREEN / AMBER / RED permission tiers.
* Launch never auto-approves.
* Agents propose; humans approve knowledge.

## U-Proof lesson candidates (CANDIDATE — not approved)

Proposed by Agent 08 from the U-Proof build/QA history (source: CTOS-001 seed). Evidence references
ticket codes, holds and QA items already in the store. All ten remain CANDIDATE until a human decides.

| Category | Lesson | Evidence |
|---|---|---|
| qa | Builder must not self-certify visual quality | CT-UP-007, 008, 019 |
| elementor | Structured Elementor writes must be re-read after save | CT-UP-003A, 016-BATCH |
| qa | Browser rendering beats HTTP-200 checks | CT-UP-019, 021 |
| qa | Real viewport emulation required for responsive QA | CT-UP-019, 020, qa_up_1 |
| wordpress | wp_slash semantics differ between WordPress metadata APIs and raw DB writes | CT-UP-003A |
| wordpress | Raw database writes are a narrowly-scoped fallback only | CT-UP-003A, 016-BATCH |
| safety | Back up before every material mutation stage | CT-UP-003, 018-BATCH |
| elementor | Shared template CSS propagation must be verified on consuming pages | CT-UP-003A, 005, 006 |
| qa | Visual QA and implementation QA are separate responsibilities | CT-UP-019, 021 |
| qa | Human/client journey QA is a launch gate | hold_up_1, hold_up_2, appr_up_launch |

## What is deliberately not here

* No automatic promotion, no confidence-threshold auto-approval, no decay/forgetting jobs.
* No provider is asked to "learn"; knowledge is injected per request from APPROVED items only.
* No PROJECT facts were invented for U-Proof; the store's existing records are the evidence.

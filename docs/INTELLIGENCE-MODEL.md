# Intelligence Model — memory scopes and learning rules

CT-OS does **not** have unrestricted self-learning. Agents may propose; humans decide what the agency
knows. This document describes the four knowledge scopes, the item model, the rules that enforce
human approval, and the seeded U-Proof lesson candidates.

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
reviewer ("Production Lead" in Phase 1 — real identities arrive with auth) and writes an activity event.
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

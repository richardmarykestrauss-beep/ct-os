# Skill System

CTOS-003 (Parts I, J, K, L) introduces one new entity, `Skill`, covering two concepts the ticket
describes separately: an **instruction pack** (reusable agent behaviour, e.g. Agent 02's UX review
checklist) and a **reviewed skill** (a design or build practice guide, e.g. the CT Visual Design
Skill). Both are, structurally, "an approved body of text an agent's execution context may include" —
giving them one lifecycle is the deliberately un-over-engineered reading of the ticket: one small
system, not two. See `src/data/types.ts` (the `Skill` interface, with the same reasoning in a comment
directly above it) and `src/services/skills.ts`.

## The Skill entity

```
id · name · version · kind (instruction_pack | design_review | build_practice | other)
status (DRAFT | CANDIDATE | APPROVED | DEPRECATED | REJECTED)
scope (free-text label, e.g. "agent-behaviour", "design-review", "build-practice")
ownerAgentIds[] · reviewerAgentIds[] · content · evidence[]
supersedesId (previous version's id in this lineage, or null)
approvedBy · approvedById · approvedAt (human only, never an agent)
createdAt · updatedAt
```

`ownerAgentIds` are the agents this skill primarily belongs to; `reviewerAgentIds` are agents that may
reference it without owning it (e.g. Agent 06 QA reviews Agent 03's and Agent 05's skills). `evidence`
is ticket codes, project names or artifact ids — whatever grounds the skill in real validated
experience, the same pattern `KnowledgeItem.evidence` uses.

## Lifecycle

```
DRAFT ──▶ CANDIDATE ──▶ APPROVED ──▶ DEPRECATED
  │           │
  └────┬──────┘
    REJECTED (terminal; from DRAFT or CANDIDATE only — never from APPROVED)
```

`reviewSkill(data, reviewer, skillId, decision, note?)` enforces the transitions:

* `APPROVED` requires the skill currently be `DRAFT` or `CANDIDATE`.
* `REJECTED` requires the skill **not** be `APPROVED` — an approved skill is deprecated, never
  rejected.
* `DEPRECATED` requires the skill currently be `APPROVED`.

`createSkill()` always starts a skill at `DRAFT` (or `CANDIDATE`, if given explicitly) — never
`APPROVED`; only a review can move it there.

## Human-only approval — three layers of defence

1. **Type level.** `SkillActor` is `{kind: "human", name, id, role}` | `{kind: "agent", agentId}`.
   `reviewSkill`'s first line is `if (reviewer.kind !== "human") throw new SkillPolicyError(...)` — an
   agent-shaped actor cannot even reach the approval logic.
2. **Runtime role check.** Even a human actor is re-checked: `reviewer.role !== "ADMIN" &&
   reviewer.role !== "PRODUCTION_LEAD"` throws `SkillPolicyError`. Only Admin or Production Lead may
   review a skill — the same tier the AMBER approval path in `docs/AUTH-AND-PERMISSIONS.md` uses.
3. **Database trigger.** `supabase/migrations/0003_intelligence_model.sql`'s
   `ctos_guard_skill_review()` trigger refuses any row whose `status = 'APPROVED'` has a null or
   `agent`-prefixed `approved_by`, and (on update, when `auth.uid()` is known) refuses an approval
   whose `approved_by_id` doesn't match the authenticated user — defence in depth alongside the
   application-layer check, the same pattern `ctos_guard_knowledge_review` uses for `KnowledgeItem`.

## Versioning: editing an APPROVED skill never happens in place

`reviseSkill(data, skillId, patch)`:

* If the skill is `DRAFT` or `CANDIDATE`, the edit is a normal in-place update.
* If the skill is `APPROVED`, the edit instead creates a **new row**: `version: existing.version + 1`,
  `status: "DRAFT"`, `supersedesId: existing.id`, a fresh id, and cleared `approvedBy`/`approvedById`/
  `approvedAt`. The original `APPROVED` row is left completely untouched and keeps serving production
  until the new version is itself approved.

This means production never sees a half-edited approved skill, and there is always a specific,
frozen, approved version an execution record can point to.

## `approvedSkillsForAgent` — the production gate

```ts
function approvedSkillsForAgent(data: OSData, agentId: string, instructionPackIds: string[] = []): ActiveSkillRef[]
```

This is **the** enforcement point for "only APPROVED skills ever reach a production execution
context." It filters `data.skills` to those that are `isProductionReady()` (status `APPROVED`) **and**
either owned by the agent, reviewed by the agent, or named in the agent's own `instructionPackIds` —
then maps the survivors to `ActiveSkillRef` (`{id, name, version, kind, content}` — no approval
metadata, no `evidence`, nothing but what the execution context needs). A `CANDIDATE` or `DRAFT` skill
never appears here, no matter who owns or reviews it.

Callers: `src/services/agent-jobs.ts#buildExecutionRequestFromData`, and both gateway stores'
`loadJobContext()` (`src/gateway/store.ts#OSDataGatewayStore`,
`src/gateway/supabase.ts#SupabaseGatewayStore`) — every path that builds a job's execution envelope
calls this function, so there is no route into an execution request that bypasses the APPROVED filter.

`skillProvenance(skills: ActiveSkillRef[]): string[]` turns the active set into `"id@version"`
strings, recorded as `skillIds` on the resulting `AgentRun`/`ExecutionLog` rows — see
`docs/EXECUTION-GATEWAY.md`.

## Where it shows up

`toProviderRequest()` (`src/services/agent-jobs.ts`) renders `ExecutionRequest.activeSkills` as its
own labelled block in the system prompt, separate from DOCTRINE/AGENCY KNOWLEDGE/PROJECT
FACTS/TASK CONTEXT:

```
ACTIVE SKILLS (approved only — v1):
- UX & Conversion Review Checklist v1 (v1): Before proposing a sitemap or conversion journey: ...
```

`/knowledge` has a read-only "Skills" panel with DRAFT/CANDIDATE/APPROVED/DEPRECATED tabs
(`src/routes/knowledge.tsx`). There is deliberately no approve/reject UI wiring yet: the service layer
is fully implemented, tested and enforced server-side, but the interactive review UI was not built
this round to avoid rushed, untested store/action plumbing. The Agents page shows each agent's
capabilities, priority, and (when set) its active instruction pack's name/version/status
(`src/routes/agents.tsx`).

## Relationship to `KnowledgeItem` / `knowledge.ts`

`Skill` and `KnowledgeItem` are separate entities that solve related but distinct problems, and
deliberately do not share a table:

* `KnowledgeItem` (`src/services/knowledge.ts`) is scoped **DOCTRINE / AGENCY / PROJECT / TASK** —
  it's about what an agent knows (facts, patterns, client context), and TASK-scope items are
  ephemeral, cleared when a job ends.
* `Skill` is not scoped by knowledge scope at all — it's about **how** an agent should behave or
  judge quality (an instruction pack or a review rubric), and it's always durable (nothing analogous
  to TASK scope; a skill lives until deprecated).
* Both share the same underlying shape of the human-approval problem — "agents propose, only a human
  approves, and the approval is enforced at more than one layer" — and both use the same actor-typing
  trick (`{kind: "human"} | {kind: "agent"}`) to make agent-approval a compile error, not just a
  convention. `KnowledgeItem`'s reviewer field predates `Skill`'s `SkillActor`; the two were kept
  structurally parallel on purpose.
* Both feed the same execution envelope (`ExecutionRequest`) but as separate fields
  (`approvedKnowledge` vs. `activeSkills`) rendered as separate, clearly labelled sections of
  `systemContext`, so a reviewer reading execution history can tell "the agent knew this fact" apart
  from "the agent was instructed to behave this way."

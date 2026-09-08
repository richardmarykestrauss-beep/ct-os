# Creative Touch Website OS — Architecture

CT-OS is the **Creative Touch Website Production Operating System**. It is not an AI-agent dashboard.
It owns project state, client state, agent identities, workflow, approvals, permissions, artifacts,
knowledge, execution history, QA evidence and deployment state. Claude, OpenAI and Gemini are
replaceable intelligence providers behind a neutral interface.

Phase: **CTOS-001 — Persistent Core + Provider-Neutral Agent Foundation** (this document reflects that state).

## Stack

TypeScript · React 19 · Vite 7 · TanStack Router (file-based) · Tailwind CSS 4 · Radix/shadcn-style
primitives · Lucide · Zod · React Hook Form · Vitest. `@supabase/supabase-js` is loaded lazily and only
from `src/services/supabase/client.ts`.

## Planes

| Plane | What it is | Where |
|---|---|---|
| Control plane | This app. Records state, decisions, evidence. Never mutates a client site. | `src/state`, `src/services`, `src/routes` |
| Intelligence plane | Replaceable model providers behind `AIProvider` + `ModelRouter`. | `src/ai` |
| Execution plane | WordPress, hosting, DNS, Google, Meta… (adapters arrive later). | `src/services/integrations.ts` (contracts only) |

## Source layout

```
src/
  data/
    types.ts            Domain model (see "Entities")
    state-machine.ts    Project state machine, phases, permission tiers, safety pipeline
    seed.ts             U-Proof seed: real history, no invented dates; agents 00–08; gates;
                        integrations; doctrine; 10 U-Proof lesson CANDIDATES
  ai/
    types.ts            AIProvider, ProviderRequest/Response, RouterResult, errors
    registry.ts         ProviderRegistry + createDefaultRegistry() (all stubs)
    router.ts           ModelRouter: preferred → fallbacks, capability + availability filter
    providers/          StubProvider base; ClaudeProvider, OpenAIProvider, GeminiProvider seams
  services/
    repository.ts       OSRepository seam, InMemoryRepository, createRepository() (env-driven)
    supabase/           SupabaseRepository (diff-upsert), row mapping, SDK client (lazy)
    artifacts.ts        Artifact types, creation, versioning, lineage
    agent-jobs.ts       AgentJob contract, lifecycle, runs, request assembly, executeJob()
    handoffs.ts         Handoff records + the standard production chain
    knowledge.ts        Four knowledge scopes, proposal/approval rules, context assembly
    integrations.ts     Adapter contracts + status labels
  state/
    os-store.tsx        Context + reducer over OSData. Every mutation is an action.
  routes/               Overview · Projects · Project detail (…+ Runs tab) · Agents · Build Queue
                        · QA · Approvals · Clients · Knowledge · Settings
supabase/migrations/    0001_ctos_core.sql — full schema, guard trigger, RLS
docs/                   This file, AGENT-ARCHITECTURE, INTELLIGENCE-MODEL, SUPABASE-SCHEMA
```

## Entities

Core (unchanged from the MVP, extended): Client · Project · ProjectPhase · Agent · ProjectPage ·
Ticket · Artifact · QAItem · LaunchHold · Approval · ActivityEvent.

Added in CTOS-001: **QARun** · **GateDefinition** · **AgentJob** · **AgentRun** · **Handoff** ·
**KnowledgeItem** · **AgentLesson** · **Integration** · **ProjectIntegration**.

All IDs are strings (`text` in Postgres): seeded readable ids (`proj_uproof`) and generated
`<prefix>_<uuid>` ids coexist. Unknown historical timestamps are `null` — never invented.

## Data flow

```
UI  ──actions──▶  os-store reducer  ──(pure services)──▶  new OSData  ──persist──▶  OSRepository
                        │                                                          ├─ InMemoryRepository
                        └── runTicket() awaits ModelRouter.execute() then           └─ SupabaseRepository
                            dispatches RUN_TICKET_RESULT                                (diff upsert)
```

* Every mutation is a reducer action. Services (`artifacts`, `agent-jobs`, `handoffs`, `knowledge`)
  are pure functions `OSData → OSData` so the reducer, the tests and future server-side writers share
  one implementation.
* The only async step is provider execution. `actions.runTicket` builds the provider request from the
  current snapshot, dispatches `RUN_TICKET_START`, awaits the router, then dispatches
  `RUN_TICKET_RESULT` (success or failure). The reducer never awaits.

## Provider independence

* Nothing outside `src/ai/providers/*` may import a provider SDK.
* An **agent** is a stable identity (code, role, permissions, artifact contracts). Its
  `providerPolicy` (`preferred`, `fallbacks`, optional `reviewer`) is data and can change at runtime
  (Agents page) without touching the agent, its jobs or its artifacts.
* A **job** copies the agent's policy at creation so execution history stays truthful even if the
  policy changes later.
* The **router** decides: preferred → fallbacks, minus providers missing a required capability, minus
  unavailable providers, minus providers disabled in settings. Every attempt is recorded as an
  `AgentRun`. See `docs/AGENT-ARCHITECTURE.md`.

## Artifact handoffs

Agents communicate through versioned, typed artifacts. A `Handoff` records source agent, destination
agent, input artifacts, output artifact, job/run and status. There is no agent-to-agent chat. See
`docs/AGENT-ARCHITECTURE.md` for the chain and `src/services/handoffs.ts`.

## Memory scopes

DOCTRINE · AGENCY · PROJECT · TASK. Agents propose; only humans approve. See
`docs/INTELLIGENCE-MODEL.md`.

## Permission model

Tiers GREEN / AMBER / RED (`state-machine.ts` `PERMISSION_MODEL`). Each agent carries a
`permissionLevel`; each job copies it and the provider request states it. Enforcement on real actions
arrives with the execution plane; in Phase 1 it is recorded, displayed and passed to providers.

## Persistence

`createRepository()` picks Supabase when `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set
(or `VITE_CTOS_REPOSITORY=supabase`), otherwise the in-memory seed. If Supabase fails to load, the
store falls back to memory and Settings shows why. See `docs/SUPABASE-SCHEMA.md`.

## Safety doctrine

BUILD → PREVIEW → HUMAN DESIGN APPROVAL → QA → FINAL REGRESSION AUDIT → CONTROLLED ACTIVATION TESTING →
HUMAN LAUNCH APPROVAL → LIVE. Launch never auto-approves; approving with open holds is an explicit,
recorded human decision. These rules are also seeded as DOCTRINE knowledge items.

## Validation

`npm run typecheck` · `npm test` (Vitest, 31 tests: artifacts, jobs, router fallback, knowledge,
repository compatibility, store smoke) · `npm run build` · `npm run verify` (all three).

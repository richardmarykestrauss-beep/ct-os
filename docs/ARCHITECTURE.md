# Creative Touch Website OS — Architecture

CT-OS is the **Creative Touch Website Production Operating System**. It is not an AI-agent dashboard.
It owns project state, client state, agent identities, workflow, approvals, permissions, artifacts,
knowledge, execution history, QA evidence and deployment state. Claude, OpenAI and Gemini are
replaceable intelligence providers behind a neutral interface.

Phase: **CTOS-003 — Live Multi-Model Intelligence + Provider Continuity + Design Skill Foundation**
(this document reflects that state; CTOS-001 laid the persistent core, CTOS-002 added identity, the
execution gateway and the first live provider adapter).

## Stack

TypeScript · React 19 · Vite 7 · TanStack Router (file-based) · Tailwind CSS 4 · Radix/shadcn-style
primitives · Lucide · Zod · React Hook Form · Vitest. `@supabase/supabase-js` is loaded lazily and only
from `src/services/supabase/client.ts`.

## Planes

| Plane | What it is | Where |
|---|---|---|
| Control plane | This app. Records state, decisions, evidence. Never mutates a client site. | `src/state`, `src/services`, `src/routes` |
| Identity | Supabase Auth + `profiles` (roles ADMIN / PRODUCTION_LEAD / TEAM_MEMBER / VIEWER). | `src/auth`, migration 0002 |
| Execution gateway | Server-side: verifies the session, enforces permission tiers, holds provider secrets, validates output, writes execution history. | `src/gateway`, `supabase/functions/agent-execute` |
| Intelligence plane | Replaceable model providers behind `AIProvider` + `ModelRouter`; OpenAI, Claude and Gemini all live, server-side-only adapters. | `src/ai` |
| Execution plane | WordPress, hosting, DNS, Google, Meta… (adapters arrive later). | `src/services/integrations.ts` (contracts only) |

## Source layout

```
src/
  data/
    types.ts            Domain model (see "Entities")
    state-machine.ts    Project state machine, phases, permission tiers, safety pipeline
    seed.ts             U-Proof seed: real history, no invented dates; agents 00–08; gates;
                        integrations; doctrine; 10 U-Proof lesson CANDIDATES
  auth/
    backend.ts          SupabaseAuthBackend (real) · LocalAuthBackend (no Supabase) · roles
    AuthProvider.tsx    Session context; main.tsx shows SignInScreen when there is no session
  schemas/
    artifacts.ts        Versioned Zod output schemas (<type>@<version>), examples, validateOutput, JSON Schema export
  ai/
    types.ts            ExecutionRequest / ExecutionResult contracts, AIProvider, RouterAttempt
    registry.ts         createBrowserRegistry() (stubs only) · createServerRegistry(env) (live adapters)
    router.ts           ModelRouter: policy order, capability/availability filter, validation-driven fallback
    providers/          StubProvider · OpenAIProvider · ClaudeProvider · GeminiProvider (all live)
    ranking.ts          rankCandidates()/explainSelection() — deterministic, explainable scoring
    pricing.ts          Versioned illustrative pricing table; estimateCostUsd()/totalTokensOf()
  gateway/
    core.ts             handleExecute / handleHealth — auth → truth → permission → route → records
    http.ts             Runtime-neutral HTTP surface (Deno + Node wrappers call it)
    store.ts            GatewayStore interface · OSDataGatewayStore (local/tests)
    supabase.ts         SupabaseGatewayStore / SupabaseGatewayAuth (service role) · FakeGatewayDb
    client.ts           HttpGatewayClient (browser → server) · EmbeddedGatewayClient (local mode)
    node.ts / vite-plugin.ts   Dev middleware serving POST /agent-execute with server-only env
  services/
    repository.ts       OSRepository seam, InMemoryRepository, createRepository() (env-driven)
    supabase/           SupabaseRepository (diff-upsert), row mapping, SDK client (lazy)
    artifacts.ts        Artifact types, creation, versioning, lineage
    agent-jobs.ts       AgentJob contract, lifecycle, runs, envelope assembly, applyGatewayRecords()
    job-approvals.ts    AMBER approvals / RED authorizations, action fingerprint, checkPermission()
    handoffs.ts         Handoff records + the standard production chain
    knowledge.ts        Four knowledge scopes, proposal/approval rules, context assembly
    skills.ts           Skill entity: lifecycle, human-only approval, approvedSkillsForAgent()
    integrations.ts     Adapter contracts + status labels
  state/
    os-store.tsx        Context + reducer over OSData. Every mutation is an action.
  routes/               Overview · Projects · Project detail (…+ Runs tab) · Agents · Build Queue
                        · QA · Approvals · Clients · Knowledge · Settings
supabase/migrations/    0001_ctos_core.sql — core schema · 0002_identity_gateway.sql — profiles,
                        approvals, logs, RLS · 0003_intelligence_model.sql — priority/usage/cost/
                        skill-provenance columns, skills table + human-only-approval trigger
supabase/functions/     agent-execute — the Edge Function wrapper around src/gateway (Deno)
scripts/                security-scan.mjs (bundle secret scan) · bundle-edge-function.mjs
docs/                   ARCHITECTURE, AGENT-ARCHITECTURE, INTELLIGENCE-MODEL, SUPABASE-SCHEMA,
                        EXECUTION-GATEWAY, AUTH-AND-PERMISSIONS, PROVIDER-ADAPTERS,
                        PROVIDER-ROUTING, SKILL-SYSTEM, CT-VISUAL-DESIGN-SKILL,
                        CT-ELEMENTOR-BUILDER-SKILL
```

## Entities

Core (unchanged from the MVP, extended): Client · Project · ProjectPhase · Agent · ProjectPage ·
Ticket · Artifact · QAItem · LaunchHold · Approval · ActivityEvent.

Added in CTOS-001: **QARun** · **GateDefinition** · **AgentJob** · **AgentRun** · **Handoff** ·
**KnowledgeItem** · **AgentLesson** · **Integration** · **ProjectIntegration**.

Added in CTOS-002: **JobApproval** (AMBER approvals / RED authorizations) · **ExecutionLog**
(gateway-written history) · identity fields (`actorId`, `decidedById`, `reviewedById`, `requestedById`)
· run validation fields (`validation`, `latencyMs`, `errorCategory`, status `FAILED_VALIDATION`).
`profiles` (auth → role) lives outside OSData.

Added in CTOS-003: **Skill** (instruction packs and reviewed design/build skills, one lifecycle —
see `docs/SKILL-SYSTEM.md`) · `Agent.mission`/`exclusions`/`defaultPriority`/`instructionPackIds` ·
`AgentJob.executionPriority` · `AgentRun`/`ExecutionLog` fields `totalTokens`, `estimatedCostUsd`,
`selectionReason`, `skillIds`. `ProviderCapability` grew from six values to nine (`reasoning`,
`fast_generation`, `creative_generation` added) and `ProviderConnectionState` grew from three values
to seven (`unavailable`, `rate_limited`, `degraded` added) — see `docs/INTELLIGENCE-MODEL.md` and
`docs/PROVIDER-ADAPTERS.md`.

All IDs are strings (`text` in Postgres): seeded readable ids (`proj_uproof`) and generated
`<prefix>_<uuid>` ids coexist. Unknown historical timestamps are `null` — never invented.

## Data flow

```
UI ──actions(+actor)──▶ os-store reducer ──(pure services)──▶ new OSData ──persist──▶ OSRepository
                              │                                                       ├─ InMemory
     runTicket():             │                                                       └─ Supabase
       RUN_TICKET_START ──▶ persist ──▶ GatewayClient.execute(jobId) ──▶ POST /agent-execute
                                                                             │ (server: auth, tier,
                                                                             │  envelope, router,
                                                                             │  validation, records)
       APPLY_EXECUTION ◀──────────────── { result, records } ◀───────────────┘
```

* Every mutation is a reducer action carrying the signed-in `actor`. Services (`artifacts`,
  `agent-jobs`, `job-approvals`, `handoffs`, `knowledge`) are pure `OSData → OSData` functions shared
  by the reducer, the gateway (`OSDataGatewayStore` / `applyGatewayRecords`) and the tests.
* The browser never composes a prompt or calls a provider. `runTicket` starts the job (or records the
  approval it still needs), persists so the server sees the RUNNING job, calls the gateway with the
  job id, then mirrors the returned records. In local mode the same core runs embedded with stubs.

## Provider independence

* Nothing outside `src/ai/providers/*` may import a provider SDK.
* An **agent** is a stable identity (code, role, permissions, artifact contracts). Its
  `providerPolicy` (`preferred`, `fallbacks`, optional `reviewer`) is data and can change at runtime
  (Agents page) without touching the agent, its jobs or its artifacts.
* A **job** copies the agent's policy at creation so execution history stays truthful even if the
  policy changes later.
* The **router** decides: preferred → fallbacks, minus providers missing a required capability, minus
  unavailable providers, minus providers disabled in settings; every answer is validated against the
  job's `<type>@<version>` schema and a failed validation falls through to the next provider. Every
  attempt is recorded as an `AgentRun` and an `ExecutionLog`. See `docs/PROVIDER-ADAPTERS.md`.
* **Secrets** live only in the gateway (`docs/EXECUTION-GATEWAY.md`); `npm run security:scan` proves
  none reach the bundle.
* As of CTOS-003, `OpenAIProvider`, `ClaudeProvider` and `GeminiProvider` (`src/ai/providers/*.ts`)
  are all real, server-side-only adapters implementing the same `AIProvider` interface — a provider
  without its credential simply reports `not_configured` rather than crashing. All three share a
  `HealthTracker` (`src/ai/providers/health.ts`) that derives `rate_limited`/`degraded`/`unavailable`
  connection states from the adapter's own recent failures. See `docs/PROVIDER-ADAPTERS.md`.
* Within the filtered candidate set, `rankCandidates()` (`src/ai/ranking.ts`) orders providers by a
  transparent, explainable score (preferred-provider bonus, capability bonuses keyed by the job's
  `ExecutionPriority`) and records a human-readable `selectionReason` on every attempt. See
  `docs/PROVIDER-ROUTING.md` and `docs/INTELLIGENCE-MODEL.md`.
* An agent's execution context can also include **APPROVED skills** — instruction packs and reviewed
  design/build practice guides (`src/services/skills.ts`) — rendered as a labelled "ACTIVE SKILLS"
  block in the system prompt, never a CANDIDATE or DRAFT one. See `docs/SKILL-SYSTEM.md`.

## Artifact handoffs

Agents communicate through versioned, typed artifacts. A `Handoff` records source agent, destination
agent, input artifacts, output artifact, job/run and status. There is no agent-to-agent chat. See
`docs/AGENT-ARCHITECTURE.md` for the chain and `src/services/handoffs.ts`.

## Memory scopes

DOCTRINE · AGENCY · PROJECT · TASK. Agents propose; only humans approve. See
`docs/INTELLIGENCE-MODEL.md`.

## Identity and permission model

Supabase Auth + `profiles` roles (ADMIN / PRODUCTION_LEAD / TEAM_MEMBER / VIEWER). Tiers GREEN / AMBER
/ RED are **enforced server-side by the gateway**: GREEN runs for any executor role; AMBER needs an
approved `job_approvals` record by a lead/admin for the exact action; RED needs the calling user's own
authorization for the exact action. See `docs/AUTH-AND-PERMISSIONS.md`.

## Persistence

`createRepository()` picks Supabase when `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set
(or `VITE_CTOS_REPOSITORY=supabase`), otherwise the in-memory seed. If Supabase fails to load, the
store falls back to memory and Settings shows why. See `docs/SUPABASE-SCHEMA.md`.

## Safety doctrine

BUILD → PREVIEW → HUMAN DESIGN APPROVAL → QA → FINAL REGRESSION AUDIT → CONTROLLED ACTIVATION TESTING →
HUMAN LAUNCH APPROVAL → LIVE. Launch never auto-approves; approving with open holds is an explicit,
recorded human decision. These rules are also seeded as DOCTRINE knowledge items.

## Validation

`npm run typecheck` · `npm test` (Vitest, 179 tests: artifacts, jobs, router, ranking, pricing,
knowledge, skills, repository, store, gateway enforcement/validation/fallback/continuity, providers
for all three live adapters, provider health, multi-provider registry, security, HTTP surface,
schemas, auth) · `npm run security:scan` (bundle secret scan) · `npm run gateway:check` (Deno
type-check + bundle) · `npm run build` · `npm run verify` (typecheck + tests + security scan).

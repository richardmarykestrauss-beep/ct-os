# Execution Gateway

The execution gateway is the only place in CT-OS where an AI provider is called. It sits between the
browser and the providers, holds every provider secret, enforces the permission tier, validates the
structured output, and writes the execution history. The browser sends a **job id** and a session
token — never a prompt it composed itself, never a key.

```
Browser ──POST /agent-execute {jobId}──▶ Gateway (server)
                                          ├─ 1. verify session (Supabase Auth JWT → profiles.role)
                                          ├─ 2. load job truth from the database (job, agent, inputs,
                                          │     APPROVED knowledge, approvals, previous output)
                                          ├─ 3. enforce permission tier (GREEN / AMBER / RED)
                                          ├─ 4. build ExecutionRequest → ModelRouter
                                          │     provider ▸ Zod validation ▸ fallback ▸ …
                                          ├─ 5. write runs, artifact, handoff, consumed approval,
                                          │     execution logs (service role)
                                          └─ 6. respond { result, records } — the client mirrors records
```

## Why a Supabase Edge Function (and a matching dev middleware)

CT-OS already runs on Supabase for auth and persistence, so an Edge Function is the smallest
production-sensible server: no extra host, secrets managed with `supabase secrets set`, the service
role available in-function, and the user's JWT verified by the same project that issued it.

To keep the developer loop simple, the identical core (`src/gateway/core.ts`) is also served by a Vite
dev middleware at `/agent-execute` during `npm run dev` (`src/gateway/vite-plugin.ts` →
`src/gateway/node.ts`). It reads the same server-only variables from `.env.local`. Both wrappers are
thin: the routing, auth extraction, enforcement, validation and logging are written once and tested once.

| Runtime | Entry | Secrets from |
|---|---|---|
| Production | `supabase/functions/agent-execute/index.ts` (Deno) | `supabase secrets set` |
| `npm run dev` | Vite middleware `POST /agent-execute` | process env + `.env.local` (non-`VITE_` names) |
| Local mode (no Supabase) | `EmbeddedGatewayClient` runs the core in-process with **stub** providers | none exist |
| Tests | core + `OSDataGatewayStore` / `FakeGatewayDb` | none |

Local mode is deliberately honest: there is no server, so there is nothing to protect and no live
provider. It exists so the pipeline (permission check → validation → runs → logs) behaves identically
while Supabase is not configured.

## Endpoints

* `POST <gateway>` — body `{ jobId, artifactTitle? }`, header `Authorization: Bearer <supabase access token>`.
  Responses (JSON): `{ ok: true, result: ExecutionResult, records, permission }` or
  `{ ok: false, code, message, permission?, status }` with HTTP 401 / 403 / 404 / 409 / 400.
* `GET <gateway>/health` — provider connection states (`connected | not_configured | stub`), the
  gateway mode, and the caller's identity. Auth required. No secret values, only env var **names**.

`<gateway>` resolves to `VITE_CTOS_GATEWAY_URL`, else `/agent-execute` in dev, else
`<VITE_SUPABASE_URL>/functions/v1/agent-execute`.

## Contracts

**ExecutionRequest** (`src/ai/types.ts`) — provider-neutral envelope:
`jobId, projectId, agentId, agent{code,name,role,responsibilities}, taskType, instructions,
inputArtifacts[], approvedKnowledge{doctrine[],agency[],project[],task[]}, availableTools[],
requiredOutputSchema, schemaVersion, preferredProvider, fallbackProviders[], requiredCapabilities[],
permissionLevel, requestedById`.

Only **APPROVED** knowledge is ever included (`knowledgeForJob`). It is split by scope and rendered as
separately labelled sections (`DOCTRINE`, `AGENCY KNOWLEDGE`, `PROJECT FACTS`, `TASK CONTEXT`) in the
system context, so agency doctrine and one client's facts never blur. Input artifacts are the job's
declared inputs only (payloads trimmed at 12 KB) — never the project's whole history.

**ExecutionResult** — `provider, model, runId, status (COMPLETED | FAILED | FAILED_VALIDATION |
REJECTED), output, outputSchema, schemaVersion, usage{inputTokens,outputTokens}, latencyMs,
finishReason, error{category,message,issues?}, attempts[]`. Provider-specific shapes stop at the adapter.

## Server-side secret boundary

* Provider keys and the service-role key are read only by `createServerRegistry(env)` and the runtime
  wrappers. The browser registry (`createBrowserRegistry`) can only construct stubs.
* Vite inlines `VITE_*` variables only; `OPENAI_API_KEY` etc. are unprefixed on purpose.
* `npm run security:scan` builds the bundle with canary secret values in the environment and fails if
  any value, any server-only module marker, or any `import.meta.env.*_API_KEY` read reaches `dist/`.
* Adapters redact their own key from error text; logs and run records carry env var **names** only.
* The gateway never logs tokens. Execution logs keep a provider's raw output only when validation
  failed (for diagnosis), and never any client content beyond what the job already held.

## Permission enforcement (server-side)

See `docs/AUTH-AND-PERMISSIONS.md`. In short: the gateway computes the effective tier as the higher of
the job's recorded tier and the agent's current tier, then requires — for AMBER — an `APPROVED`
`job_approvals` row for this job **and** this action fingerprint whose approver's role is re-read from
`profiles`; for RED — an `AUTHORIZATION` row issued by the calling user for this exact action. Denials
are logged (`execution_logs.status = REJECTED`) and return 403. Approvals are consumed on execution.

## Execution logging

One `execution_logs` row per provider attempt (plus one for a rejected call): agent, provider, model,
start/end, status, fallback index, permission check, validation result, artifact id, error category,
usage. Written with the service role; readable by ADMIN and PRODUCTION_LEAD. The client mirrors the
rows it receives but never writes to this table (the repository treats it as server-owned).

## Deploying the Edge Function

```
npm run gateway:check        # deno type-check of the source + a bundled, Deno-verified build
npm run gateway:bundle       # → supabase/functions/agent-execute/dist/index.js (git-ignored)
supabase secrets set OPENAI_API_KEY=… OPENAI_MODEL=gpt-4o-mini
supabase functions deploy agent-execute
```

The function source imports the app's modules through `@/…` (import map in `deno.json`, with
`sloppy-imports` for extension-less paths). If the deployed runtime rejects that, deploy the bundled
`dist/index.js` instead — it inlines all CT-OS code and references `npm:zod@4` and
`npm:@supabase/supabase-js@2` only.

## Failure behaviour

| Situation | Job | Ticket | Response |
|---|---|---|---|
| No session / invalid token | untouched | untouched | 401 |
| VIEWER, or AMBER/RED without a valid approval | untouched (log REJECTED) | untouched | 403 + reason |
| Every provider skipped/failed | FAILED | BLOCKED with warning | 200, `status: FAILED`, attempts |
| Every provider failed validation | FAILED | BLOCKED with warning | 200, `status: FAILED_VALIDATION`, issues |
| One provider validated | WAITING_APPROVAL, artifact DRAFT | REVIEW | 200, `status: COMPLETED` |

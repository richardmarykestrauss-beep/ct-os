# MCP Bridge (CTOS-004)

How an external assistant (ChatGPT, another Claude session, a future automation) reaches CT-OS
through the Model Context Protocol — what it can do, what it can't, and exactly how far "connected"
actually goes today. See `src/mcp/` for the implementation and `src/services/external-clients.ts`
for the identity/permission/audit model it's built on.

**Status honesty, up front:** this document describes a working local MCP server that has been
built, bundled and unit-tested end to end (`npm run mcp:build` succeeds; `src/__tests__/mcp.test.ts`
exercises the full tool registry against a real `McpServer` instance). **No real MCP client — not
ChatGPT, not Claude Desktop, not any other assistant — has actually connected to it in this
environment.** Everything below the "Local dev auth" section is either code that has been exercised
by tests, or a design for hosted mode that has **not** been built. Section headers say which.

## 1. What this is

CT-OS already has one execution surface: CT-OS's own agents, running through the execution gateway
(`docs/EXECUTION-GATEWAY.md`), doing real work inside a project. The MCP bridge is a **second,
much narrower** surface: a read-mostly window that lets an external assistant look at CT-OS state
and, for a small set of safe actions, ask CT-OS to do something — never do it directly.

Every MCP tool call goes through the *existing* CT-OS service layer (`src/services/*`) and the
*existing* gateway store (`src/gateway/store.ts`) — the MCP layer adds no new way to read or write
`OSData`. It adds:

- an identity for the caller (`ExternalClient`, not a CT-OS user),
- a permission ceiling on that identity (`READ_ONLY` or `GREEN_WRITE`),
- a fixed catalogue of 22 tools, each already scoped to READ_ONLY or GREEN_WRITE,
- and an audit log entry for every call, allowed or not.

## 2. MCP server

`src/mcp/server.ts` is a stdio MCP server built on `@modelcontextprotocol/sdk`'s `McpServer` +
`StdioServerTransport`. It is a plain Node entrypoint, bundled with esbuild
(`scripts/bundle-mcp-server.mjs`) into a single file:

```
npm run mcp:build     # bundles src/mcp/server.ts -> dist/mcp-server/index.js
npm run mcp:start      # runs dist/mcp-server/index.js over stdio
```

Transport is stdio only. There is no HTTP/SSE listener in this repo yet — see §14 for the hosted-mode
design, which is a design, not a deployment.

On startup the server:

1. Loads `.env.local` from the repo root if present (never overwrites an already-set env var, never
   logs a value it reads).
2. Requires `CTOS_MCP_TOKEN` to be set and at least 16 characters. If it's missing or too short, the
   process logs an error to stderr and exits(1) — it will not start unauthenticated.
3. Reads `CTOS_MCP_CLIENT_NAME` / `CTOS_MCP_CLIENT_TYPE` / `CTOS_MCP_CEILING` (validated against
   allow-lists; default to `chatgpt-local` / `chatgpt` / `READ_ONLY` if unset).
4. Registers exactly one `ExternalClient` in the in-memory store via
   `bootstrapLocalExternalClient()` — a token-hash comparison never runs for this identity; the
   process trusts whatever token it was started with, once, at boot.
5. Builds a `McpToolContext` (gateway store, provider registry, the one bootstrapped client, a
   logging `recordAccess` closure) and registers all 22 tools via `registerAllTools()`.
6. Calls `server.connect(new StdioServerTransport())` and logs a startup banner to **stderr only**
   (`console.error`) — stdout is reserved entirely for MCP JSON-RPC traffic; anything printed to
   stdout would corrupt the protocol stream.

## 3. Available tools

22 tools total: 14 read-only, 1 context-pack, 1 dashboard summary, 6 write/request. Every tool name
is prefixed `ctos.`.

### Read-only (`ctos.*`, ceiling `READ_ONLY`)

| Tool | What it returns |
|---|---|
| `ctos.system.status` | Provider connection states (via `ProviderRegistry.status()` — id/label/state/available/reason/envVar, never a credential), counts of projects/tickets/agents. |
| `ctos.projects.list` | Projects, optionally filtered by status. |
| `ctos.projects.get` | One project by id. |
| `ctos.project.timeline` | A project's activity feed. |
| `ctos.tickets.list` | Tickets, optionally filtered by project/status. |
| `ctos.tickets.get` | One ticket by id, with its comments. |
| `ctos.artifacts.list` | Artifacts, optionally filtered by project/type. |
| `ctos.artifacts.get` | One artifact by id. |
| `ctos.agents.list` | The 8 seeded agents — role, permission tier, capabilities. |
| `ctos.agent.runs` | Recent `AgentRun` executions for an agent or project. |
| `ctos.qa.status` | QA reports for a project. |
| `ctos.approvals.pending` | Open `JobApproval` rows awaiting a human. |
| `ctos.launch_holds.list` | Active launch holds for a project. |
| `ctos.knowledge.search` | APPROVED `KnowledgeItem`s matching a query/scope — never DRAFT/CANDIDATE/REJECTED. |

### Context & observability (`READ_ONLY`)

- **`ctos.context.project(project_id)`** (Part G) — a single compressed context pack for one
  project: project summary, open tickets, recent artifacts, active launch holds, pending approvals,
  APPROVED knowledge relevant to it. Designed so an external assistant can "catch up" on a project
  in one call instead of six.
- **`ctos.dashboard.summary`** (Part I) — cross-project observability: project counts by status,
  open ticket counts, pending approvals, active launch holds, and provider health, across the whole
  CT-OS instance.

### Write / request (`ctos.*`, ceiling `GREEN_WRITE`)

None of these execute a job, approve anything, or touch WordPress. Every one either creates a
low-risk record directly (ticket, comment, feedback note, knowledge proposal) or files a **request**
that a human still has to act on.

| Tool | What it does |
|---|---|
| `ctos.ticket.create` | Creates a ticket on a project. |
| `ctos.ticket.comment` | Adds a comment to an existing ticket. |
| `ctos.client_feedback.add` | Records client feedback against a project. |
| `ctos.knowledge.propose` | Proposes a `KnowledgeItem` — always created as `CANDIDATE`, using the existing `{kind:"agent", agentId:"external:<clientId>"}` actor shape, so `createKnowledgeItem`'s own pre-existing logic (not new MCP code) is what refuses to let it land as APPROVED. |
| `ctos.agent_job.request` | Calls the existing `createJob`. If the resulting job is GREEN, it's queued exactly as any GREEN job would be (never executed by the MCP layer itself — that's still the gateway's job). If AMBER, it calls the existing `requestJobApproval` with an `external` requester — always PENDING, never self-approved. If RED, **no approval row is created at all**; the response just says a human must authorize it directly in CT-OS. |
| `ctos.approval.request` | Files a request against an existing job (by id) or a project+gate. RED requests are recorded in the access log only — again, no `JobApproval` row — reusing exactly the same RED-never-self-approves logic as `agent_job.request`. |

Every write/request tool records the external client — never a CT-OS human — as the actor of
record. `ctos.knowledge.propose` and `ctos.agent_job.request`/`ctos.approval.request` render the
requester as `"<client name> (external)"`, so anything downstream (activity feed, approval UI) is
unambiguous about who really asked.

## 4. Auth model (local dev)

There is **one** external identity per running MCP server process, established once at boot from
`CTOS_MCP_TOKEN`. There is no per-request token check on the stdio transport — whoever can start
the process, and whoever the local MCP client (ChatGPT desktop config, Claude Desktop config, etc.)
is configured to be, is that one identity for the whole session. This is the correct trust model for
*local* stdio (the same shell that has the token already has full filesystem access to the repo
anyway) and is explicitly **not** the model hosted mode would use — see §14.

Required env vars (`.env.local`, never committed — see `.env.example`):

```
CTOS_MCP_TOKEN=            # >= 16 chars, generate with e.g. `openssl rand -hex 24`; guard like a password
CTOS_MCP_CLIENT_NAME=chatgpt-local
CTOS_MCP_CLIENT_TYPE=chatgpt      # chatgpt | claude | automation | other
CTOS_MCP_CEILING=READ_ONLY        # READ_ONLY | GREEN_WRITE
```

The token is hashed (SHA-256) before being stored on the `ExternalClient` record — even in-memory,
the raw value only ever exists in the env var and the one comparison at boot. No MCP tool response
ever includes a token, a hash, or any provider/service-role credential; `ctos.system.status` and
`ctos.dashboard.summary` expose provider **connection state** only (the same shape
`ProviderRegistry.status()` already returns to the CT-OS UI), never a key.

## 5. Permission ceiling

Two independent gates apply to every call, both enforced in `src/mcp/registry.ts` before a tool
handler ever runs:

1. **Client status.** `DISABLED`/`REVOKED` clients are refused outright, regardless of ceiling.
2. **Ceiling vs. tool.** A `READ_ONLY` client may call any `READ_ONLY` tool and no `GREEN_WRITE`
   tool. A `GREEN_WRITE` client may call both. There is no ceiling above `GREEN_WRITE` reachable
   from outside CT-OS — an external client can never execute a job, approve anything, or perform a
   RED action, no matter what ceiling it's given.

An optional per-client `allowedTools` allow-list can narrow this further (e.g. a client permitted
`GREEN_WRITE` overall but restricted to `ctos.ticket.create` and `ctos.ticket.comment` only).

Every refusal — bad ceiling, disabled client, failed input validation — is still logged to the
external access history with `result: "denied"` or `"error"`, so a pattern of refused calls is
visible in Settings, not silent.

## 6. Managing external assistants (Settings UI)

Settings → **External Assistants** (Admin/Production Lead only):

- Create a client: name, type, permission ceiling. The raw token is generated client-side and shown
  **once**, in a dialog that says so explicitly — it is never re-displayed, and the stored record
  only ever holds its hash and an 8-character prefix (shown in the table for identification).
- Table columns: Name (+ token prefix) / Type / Status / Ceiling / Allowed tools / Last used.
- Actions: Enable / Disable (reversible), Rotate token (issues a new token, shown once, invalidates
  the old one immediately), Revoke (terminal — a revoked client can never be re-enabled; create a
  new identity instead).
- **External access history**: a read-only table of the most recent calls — time, client, tool,
  project, permission tier, result, actor — the same data `ctos.dashboard.summary` and audit review
  would use, capped at the last 500 entries in memory.

## 7. Example calls

```
ctos.system.status {}
  -> { providers: [{id:"claude", state:"not_configured", ...}, ...], projectCount, ticketCount, agentCount }

ctos.context.project { "project_id": "proj_..." }
  -> { project, openTickets: [...], recentArtifacts: [...], activeLaunchHolds: [...],
       pendingApprovals: [...], approvedKnowledge: [...] }

ctos.ticket.create { "project_id": "proj_...", "title": "...", "description": "...", "priority": "MEDIUM" }
  -> { ok: true, data: { ticketId: "tkt_..." } }

ctos.agent_job.request { "project_id": "proj_...", "agent_id": "agent_03", "instructions": "..." }
  -> AMBER agent: { ok: true, data: { jobId, approvalId, note: "AMBER — pending human approval, not yet queued for execution" } }
  -> RED agent:   { ok: true, data: { jobId: null, note: "RED — this request is logged only; a human must authorize this directly in CT-OS" } }
```

Every response is `{ ok: true, data: ... }` or `{ ok: false, error: "..." }` — structured, never a
raw exception, and never a value pulled from `process.env` beyond what the tool explicitly
constructs.

## 8. Security boundaries (what this bridge cannot do)

- **No direct database access.** Every tool goes through `src/services/*` and the gateway store —
  the same code paths CT-OS's own UI uses. There's no separate MCP-only query path to audit.
- **No provider/service-role secrets ever leave a tool response.** Confirmed by
  `npm run security:scan` (bundle scan for secret values) and by `src/__tests__/mcp.test.ts`'s
  explicit assertions that `ctos.system.status`/`ctos.dashboard.summary` output contains no key
  material.
- **No self-approval.** AMBER requests always land as `PENDING` `JobApproval` rows created via the
  existing `requestJobApproval`; RED requests never create an approval row and are never executed —
  both paths are covered by dedicated tests.
- **No WordPress access of any kind.** No MCP tool touches WordPress; none was added, and none is
  planned in hosted mode either without a separate, explicit ticket.
- **No job execution from the MCP layer.** `ctos.agent_job.request` only ever calls `createJob` /
  `requestJobApproval` — it never calls the execution gateway. A GREEN job it creates is queued
  exactly like any other GREEN job and still needs the normal CT-OS execution path to run it.
- **Every call is logged**, allowed or refused, with the external identity, the CT-OS user (if any
  — currently always null, since local bootstrap has no CT-OS user behind it), the tool, the
  project, the permission tier, and the result.

## 9. Local connection instructions (today)

1. `cp .env.example .env.local` if you haven't already, and add a strong `CTOS_MCP_TOKEN`
   (`openssl rand -hex 24`, or any 16+ character random string).
2. `npm run mcp:build`
3. Point your MCP client (ChatGPT desktop app, Claude Desktop, etc.) at
   `node C:\CreativeTouch\website-os\dist\mcp-server\index.js` (or `npm run mcp:start` from the
   repo root) as a stdio MCP server, with `CTOS_MCP_TOKEN` (and optionally
   `CTOS_MCP_CLIENT_NAME`/`CTOS_MCP_CLIENT_TYPE`/`CTOS_MCP_CEILING`) set in that client's own env
   config for the server process.
4. Restart the MCP client so it picks up the new server and lists its 22 tools.

This has not been done in this environment — no real client's MCP config was available to edit here
— so tool discovery by an actual ChatGPT/Claude Desktop session has not been observed directly, only
via `mcp.test.ts`'s in-process harness against the real `registerAllTools()`/`McpServer` code path.

## 10. Hosted-mode design (design only — nothing here is deployed)

A future `mcp.ctsa.dev`-style hosted endpoint would reuse the *entire* tool layer
(`src/mcp/tools/*`, `src/mcp/registry.ts`) unchanged — `registerAllTools()` takes a
`McpToolContext`, and building that context is the only thing that would differ:

- **Transport**: HTTP with SSE (or streamable HTTP, per whatever the SDK's current transport is at
  build time) instead of stdio, behind TLS.
- **Per-request auth**: instead of one client bootstrapped at process boot, each request carries a
  bearer token; the server calls the *already-implemented* `verifyExternalToken(data, rawToken)` to
  resolve it to an `ExternalClient` (or reject with 401) — this function exists today and is unit
  tested, just unused by the stdio path, which trusts its boot-time token instead.
- **Rate limiting**: per-client request-rate caps (not yet designed in detail — likely a simple
  token-bucket keyed on `ExternalClient.id`, enforced before a tool handler runs, alongside the
  existing ceiling check).
- **Audit trail**: already exists — `recordExternalAccess` needs no change; a hosted deployment
  would likely move `externalAccessLog` out of in-memory `OSData` and into Supabase (the two tables
  already have a `TableSpec` in `src/services/supabase/mapping.ts`, added in this ticket, ready for
  a migration — see §11).
- **Revocation**: already exists — `revokeExternalClient` takes effect on the next request
  immediately, since hosted mode would check `client.status` per-request rather than once at boot.
- **No new database exposure**: hosted mode would call the same service layer against the same
  Supabase-backed gateway store CT-OS already uses in production — no new query surface.

None of this has been built. No DNS record, no hosting config, no deployment pipeline, and no
Supabase migration for the two new tables exists as part of this ticket — this section is scope
for a future ticket, written down now so the local design doesn't have to be re-derived later.

## 11. Limitations

- The MCP server's backing store is in-memory per process (the same `OSDataGatewayStore` local mode
  already uses) — nothing persists between `mcp:start` runs unless Supabase is configured, and no
  Supabase migration exists yet for `external_clients`/`external_access_log` even though the
  mapping layer supports both tables (deliberate — this environment has no Supabase project
  configured, and the ticket scope excludes deploying infrastructure).
- Local stdio auth is whole-process, not per-request — see §4. This is intentional for local dev,
  not a placeholder for something stronger that got skipped.
- No real external MCP client has connected in this environment (§9) — everything is verified via
  `npm run mcp:build` (bundles cleanly) and `src/__tests__/mcp.test.ts` (registers and calls every
  tool against a real `McpServer` instance, in-process).

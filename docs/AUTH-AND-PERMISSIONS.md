# Auth and Permissions

## Identity

CT-OS uses **Supabase Auth**. Every signed-in user has a row in `profiles` (`id` = auth user id,
`email`, `display_name`, `role`, `active`). The row is created by a database trigger on sign-up. Only
an ADMIN can change a role or `active` (`profiles_guard_update` trigger); users may edit their own
display name.

The browser holds the session (`SupabaseAuthBackend`, `src/auth/backend.ts`) and sends its access
token to the execution gateway, which verifies it with the service-role client
(`SupabaseGatewayAuth.verify`) and reads the role **and activation state** from `profiles` — never
from the client.

**Local mode** (Supabase not configured): `LocalAuthBackend` issues a named local identity with a
chosen role, kept in `sessionStorage` and labelled "local mode" in the sidebar, always active. It
only reaches the embedded gateway with stub providers. It is a development convenience and the
project's explicit bootstrap path for local/dev work — not a production identity, and not gated by
any of the sign-up hardening below.

**Protected routes**: `main.tsx` renders the sign-in screen instead of the router whenever there is no
session, and a "waiting for approval" screen (`PendingApprovalScreen`) instead of the router whenever
there is a session but the account is not active; every route is behind one of the two. Sign-out
clears the session and unmounts the store.

## Sign-up and activation (CTOS-002A)

CT-OS's own UI has no sign-up form — `SignInScreen` only signs in with an existing email/password.
The risk this section closes is different: **Supabase Auth's REST API accepts self-service sign-up by
default**, independent of anything CT-OS's frontend renders, because the anon key that calls it is
necessarily public (it ships in the browser bundle). Anyone who can reach the Supabase project can
call `POST /auth/v1/signup` directly. Two things used to follow from that in CTOS-002 and are fixed
here:

1. **Registration order used to decide who becomes ADMIN.** The very first person to successfully
   call that endpoint on a fresh project became ADMIN. That is now gone entirely — there is no
   "first user" case in `ctos_handle_new_user()` any more.
2. **Every self-registered account used to be a live VIEWER** — able to read the whole instance
   immediately. Now it is **inactive**.

The model: `profiles.active` (default `true` in the table definition, but the sign-up trigger always
sets it explicitly). `ctos_handle_new_user()` looks for a live row in `invites` — `email` matching
(case-insensitively), `used_at is null`, not expired — for the address that just signed up:

* **Match** → the account is created with the invite's `role`, `active = true`, and the invite is
  marked consumed (`used_at`, `used_by`). This is the normal path: an ADMIN inserts one row into
  `invites` for a new teammate's email and role, and that person's first sign-in activates it.
* **No match** → the account is created as an inactive `VIEWER`. It has a completely valid Supabase
  session — sign-in succeeds — but `ctos_active()` is `false`, so:
  * every RLS read/write policy in CT-OS's schema refuses it (see "Row-level security" below);
  * the gateway's `SupabaseGatewayAuth.verify` refuses it independently, before role/permission checks
    even run — this is deliberate defense-in-depth, the same principle CTOS-002 already applied to
    permission tiers ("UI button-hiding alone is insufficient"). A stolen or replayed token from an
    inactive account gets nothing from either layer;
  * the frontend shows `PendingApprovalScreen` instead of mounting the app.

An ADMIN activates a pending account by setting `active = true` (and, if the default `VIEWER` isn't
right, a role) on its `profiles` row — today via the Supabase SQL editor / table editor, since this
patch does not add a user-management screen (out of scope: "do not over-engineer"). The same is true
for issuing invites: `insert into invites (id, email, role) values (...)`.

The **matching logic is mirrored in `src/services/signup-policy.ts::resolveSignup`** and unit tested
there (`src/__tests__/signup-policy.test.ts`) — there is no local Postgres harness in this environment
to test the actual trigger against, so the pure-TypeScript mirror is what CI verifies; the SQL
(`ctos_handle_new_user` in `supabase/migrations/0002_identity_gateway.sql`) implements the identical
rule and is verified by direct review. If the two are ever changed independently, this comment is the
tripwire.

### Bootstrapping the first Admin

A brand-new instance has no `invites` rows and no ADMIN. Two supported ways to create the first one,
both outside application code by design (per the ticket: a required Supabase-side step is to be
documented, not worked around in code):

1. **Recommended for production**: before anyone signs up, use the Supabase Dashboard → Authentication
   → Users → "Invite user" (or the Admin API's `auth.admin.inviteUserByEmail`) for the operator's own
   email, and beforehand insert one row into `invites` for that same email with `role = 'ADMIN'`. The
   invite match fires on that first sign-up and the account is created active and ADMIN.
2. **Local/dev**: use local mode (`LocalAuthBackend`) — pick any role, including ADMIN, with no
   Supabase project involved at all. This is the "explicit bootstrap-admin path" for
   local/development work; it was already how CT-OS runs without Supabase configured, and nothing
   here changes that.

### Recommended Supabase Dashboard setting (outside source code)

For a production instance, also turn off **Authentication → Providers → Email → "Allow new users to
sign up"** once the operator's own ADMIN account exists, and create teammate accounts by inviting them
(Dashboard "Invite user", matched against an `invites` row as above) rather than leaving public
sign-up open. This is a one-time Dashboard toggle, not something migration SQL can set — it is called
out here explicitly rather than left undocumented or worked around with an insecure code-level
substitute. Leaving public sign-up on is not unsafe by itself (an unmatched sign-up is inert, per
above) but disabling it removes the ability to create inert accounts at all, which is one less thing
to reason about.

## Roles

| Role | Can | Cannot |
|---|---|---|
| ADMIN | everything below, change roles | — |
| PRODUCTION_LEAD | run jobs, approve AMBER, authorize RED for themselves, review knowledge, decide gates, edit provider policies | change roles |
| TEAM_MEMBER | run GREEN jobs, request AMBER approval, review knowledge, decide gates, edit project data | approve AMBER, authorize RED, edit provider policies |
| VIEWER | read | write anything, run jobs |

Enforced in three layers: UI (buttons hidden/disabled), store actions (role checks in pure services
such as `decideJobApproval` / `authorizeRedJob` / `reviewKnowledgeItem`), and the database (RLS: viewers
are select-only everywhere; `job_approvals_guard` and `knowledge_review_guard` triggers).

## Who did what

Every human action now records identity alongside the display name:

| Record | Fields |
|---|---|
| Activity events | `actor` (name), `actorId` |
| Phase-gate approvals (incl. Launch) | `decidedBy`, `decidedById` |
| Knowledge decisions | `reviewedBy`, `reviewedById` (also on the lesson ledger) |
| Agent jobs | `requestedById` |
| Job approvals / authorizations | `requestedById/Name`, `approvedById/Name/Role` |
| Execution logs | `requestedById` |

Seeded U-Proof history keeps `null` ids (the decisions predate identities — never invented).

## Permission tiers (Creative Touch model)

| Tier | Meaning | What the gateway requires |
|---|---|---|
| GREEN | automatic | a session with role ≥ TEAM_MEMBER |
| AMBER | human approval required | an `APPROVED` `job_approvals` row (kind `APPROVAL`) for **this job and this action fingerprint**, approved by a user whose role (re-read from `profiles`) is ADMIN or PRODUCTION_LEAD |
| RED | explicit human authorization required | an `APPROVED` row of kind `AUTHORIZATION` for this job/action, issued **by the calling user** (ADMIN or PRODUCTION_LEAD) — another lead's authorization does not count |

The **effective tier** is the higher of the tier recorded on the job and the agent's current tier, so
raising an agent's tier takes effect on queued jobs immediately.

The **action fingerprint** (`actionFingerprint`, SHA-256 over project, agent, task type, output schema,
instructions, input artifact ids, tool ids and provider policy) binds an approval to the exact work.
Changing any of those after approval voids it.

Approvals are **consumed** when the execution runs (a conditional `APPROVED → CONSUMED` update, so two
racing executions cannot both use one approval); a re-run after "needs revision" needs a fresh
approval. Every denial is written to `execution_logs` with `permission_check.outcome = denied`.

The gateway also takes a **lease** on the job (`agent_jobs.execution_claim_id/_claimed_at`, 10 min)
before executing, so a double click or two tabs cannot run, version or bill the same job twice — the
second call gets HTTP 409 "already being executed".

### Flow in the UI

1. *Run Next Ticket* on an AMBER ticket → a `PENDING` approval request appears under
   **Approvals → Job permissions** (requested action, tier, requested by).
2. A Production Lead / Admin approves (approved by + role recorded).
3. *Run Next Ticket* again → the gateway finds the approval, executes, and marks it `CONSUMED`.
4. RED: the lead/admin who will run the job clicks **Authorize for me**, then runs it. Nobody else can.

Seeded agent tiers: ORCH, 05 Builder and 07 Infrastructure are AMBER; the rest are GREEN. RED is
reserved for actions such as production activation and is applied by raising an agent's tier (or a
job's) — no seeded agent is RED.

### Approval context is authoritative, not requester-written (CTOS-002A)

`job_approvals.requested_action` is a plain-language summary written by whoever requested the
approval (`describeAction()` in `src/services/job-approvals.ts`). It was always cosmetic — the server
only ever trusts the SHA-256 `actionFingerprint`, which an approver cannot see the derivation of just
by reading a summary sentence. **Approvals → Job permissions** now shows both: the requester's summary
stays (labelled "Requester summary"), and beside it an "Authoritative job details" panel built by
`src/services/approval-context.ts::buildApprovalContext`, sourced entirely from the real
`agent_jobs`/`agents`/`projects`/`tickets`/`artifacts` records — agent, task type and output schema,
the actual `instructions` text, input artifact titles/versions, the requested tool ids, and the job's
provider policy — plus the fingerprint and requester identity that were already shown. An approver who
only reads the authoritative panel sees exactly what will execute; the requester's sentence can no
longer be the only thing standing between a misleading description and an approval.

## Database policies (0002_identity_gateway.sql)

* `ctos_role()` — security-definer helper returning the caller's role (always a value, even for an
  inactive account — callers must also check `ctos_active()`).
* `ctos_active()` (CTOS-002A) — whether the caller's account is usable at all. Every policy below
  requires it; an inactive account (see "Sign-up and activation") gets nothing from any of them.
* All CTOS-001 tables: `select` for any **active** authenticated user; insert/update when
  `ctos_active() and ctos_role() <> 'VIEWER'`; **delete is now its own, narrower policy per table**
  (CTOS-002A — previously delete was bundled into the same `for all` grant as insert/update, so any
  non-VIEWER could physically delete any row in any of these tables):
  * ADMIN-only delete: `clients`, `projects`, `agents`, `artifacts`, `agent_runs`, `activity_events`,
    `approvals`, `knowledge_items`, `agent_lessons`, `launch_holds`, `qa_runs`, `agent_jobs`,
    `job_approvals`, `execution_logs` — audit trails, records that cascade onto audit trails
    (`agent_jobs` → `job_approvals`/`execution_logs`), or launch-safety history.
  * ADMIN-or-PRODUCTION_LEAD delete: `project_phases`, `project_pages`, `tickets`, `gates`,
    `qa_items`, `handoffs`, `integrations`, `project_integrations` — routine operational records.
  * TEAM_MEMBER has no delete policy on any table above. It creates and updates within scope; removing
    something is a status/archive change (`tickets.approvalState`, `knowledge_items.status`,
    `launch_holds.resolved`, a QA run's outcome, …), not a physical delete. This mirrors
    `src/services/access-policy.ts` (`canMutate`), which is unit tested exhaustively per role/table/op
    since there is no local Postgres harness here to test the SQL itself against.
* `profiles` (CTOS-002A, narrowed): readable by the row's own owner (always, so a pending user still
  sees their own status) or an active ADMIN (everyone) — **no longer readable by every authenticated
  user**, so non-admins can no longer see other people's email addresses or roles; updatable by the
  owner (their own `display_name` only — role/`active` changes are still ADMIN-gated) or an ADMIN.
* `invites` (CTOS-002A, new): ADMIN-only, every operation.
* `job_approvals`: read requires an active account; insert/update open to active non-VIEWER, with
  `ctos_guard_job_approval` still enforcing that `APPROVED`/`CONSUMED` rows carry
  `approved_by_id = auth.uid()` and an approver role, and that `AUTHORIZATION` rows are self-issued;
  **delete is ADMIN-only** (CTOS-002A — previously any non-VIEWER could delete any approval row,
  including one requested or decided by someone else). The service role (gateway) bypasses RLS and
  triggers by design.
* `execution_logs`: readable by an active ADMIN or PRODUCTION_LEAD; still no insert/update policy for
  authenticated users at all (gateway/service-role only); delete is ADMIN-only (CTOS-002A addition, for
  administrative cleanup — there was previously no delete path for anyone but the service role).
* `knowledge_items`: status changes by a user must be recorded under that user (`reviewed_by_id`).
* `agents`: `permission_level` / `can_execute_site_changes` are ADMIN-only; `provider_policy` is
  ADMIN/PRODUCTION_LEAD-only (`agents_guard_update`).
* `agent_jobs`: a job can never carry a lower tier than its agent, and clients can never touch the
  execution lease (`agent_jobs_guard_write`). The gateway additionally treats the agent's tier as the floor.

## CTOS-002A: gaps closed from the CTOS-002 report

The four gaps CTOS-002's report flagged are addressed above:

* ~~First registrant becomes ADMIN~~ → no first-user case; role/activation come only from a matching
  `invites` row (see "Sign-up and activation").
* ~~Non-VIEWER can broadly delete ordinary rows~~ → delete is now its own per-table policy, ADMIN-only
  or ADMIN/PRODUCTION_LEAD-only, never TEAM_MEMBER (see "Database policies" above).
* ~~`profiles` fully readable by everyone~~ → readable by the row owner or an ADMIN only.
* ~~`job_approvals.requested_action` is the only context an approver sees~~ → the Approvals screen
  now renders an authoritative panel sourced from the job record itself (see "Approval context is
  authoritative" above).

## Remaining limitations (documented, not blocking)

* There is no in-app screen to create or list `invites`, or to activate a pending account — an ADMIN
  does this via the Supabase SQL/table editor today. Deliberately out of scope for this patch ("do
  not over-engineer a full RBAC/user-management system"); worth a small ADMIN-only screen later if the
  team outgrows the SQL editor for it.
* Disabling Supabase's own public sign-up toggle (Dashboard → Authentication → Providers → Email) is a
  recommendation, not something this patch can enforce from source code — see "Recommended Supabase
  Dashboard setting" above. Leaving it on is safe (unmatched sign-ups are inert) but not necessary once
  invites are the only onboarding path.
* The RLS/trigger SQL itself is verified by direct code review and by its pure-TypeScript mirrors
  (`src/services/access-policy.ts`, `src/services/signup-policy.ts`) being unit tested — there is no
  local Postgres instance in this environment to run the actual policies/triggers against. Running the
  migration against a real (or `supabase start` local) Postgres before production use is recommended
  as an integration-level check this environment could not perform.
* `invites` has no rate limiting or single-use-token delivery mechanism (e.g. emailing a signed link) —
  an ADMIN currently communicates "you're invited, sign up with this email" out of band. Fine for a
  small internal team; would need a delivery mechanism to scale beyond that.

# Supabase Schema and Persistence

Migration: `supabase/migrations/0001_ctos_core.sql`. Environment template: `.env.example`.

## Conventions

* IDs are `text` primary keys — string-safe. Seeded readable ids (`proj_uproof`, `agent_02`) and
  generated `<prefix>_<uuid>` ids coexist. No integer sequences.
* Timestamps are `timestamptz NULL`. Unknown historical dates stay NULL (U-Proof history is not backfilled).
* Domain camelCase ⇄ column snake_case is mechanical (`src/services/supabase/mapping.ts`). Arrays and
  nested objects (`provider_policy`, `counts`, `config`, `content`, `evidence`, …) are `jsonb`.
* Optional domain fields are NULL in the database and become `undefined` again on load; fields typed
  `T | null` are listed per table in `TABLES[].nullable` so NULL survives as `null`. Rows round-trip
  byte-for-byte (tested).

## Tables (20)

| Table | OSData key | Notes |
|---|---|---|
| clients | clients | |
| projects | projects | FK client |
| project_phases | phases | FK project, cascade |
| agents | agents | `provider_policy` jsonb, `permission_level`, capability + artifact-type arrays |
| project_pages | pages | |
| tickets | tickets | FK agent |
| artifacts | artifacts | `version`, `status`, `storage_location`, `schema_version`, self-FK `supersedes_artifact_id`, `content` jsonb |
| qa_runs | qaRuns | `result`, `counts` jsonb, FK artifact |
| qa_items | qaItems | FK qa_run |
| launch_holds | launchHolds | not defects |
| gates | gates | reference: STRATEGY / DESIGN / STAGING_BUILD / LAUNCH, `required_artifact_types`, `confirm_on_open_holds` |
| approvals | approvals | `gate` FK → gates.key |
| activity_events | activity | ordered by `"order"`; `at` nullable |
| agent_jobs | agentJobs | the AgentJob contract; FK output artifact |
| agent_runs | agentRuns | one row per provider attempt; FK job cascade |
| handoffs | handoffs | FK source/destination agent, job, run, output artifact |
| knowledge_items | knowledgeItems | scope/status; check: DOCTRINE/AGENCY have no project, PROJECT/TASK must; `confidence numeric(3,2)` |
| agent_lessons | agentLessons | ledger; FK knowledge item cascade |
| integrations | integrations | plane: control / execution / intelligence; `provider_id` for intelligence rows |
| project_integrations | projectIntegrations | non-secret `config` jsonb + `credentials_ref` pointer; unique (project, integration) |

Guard rails in the migration:

* `knowledge_review_guard` trigger: a non-TASK `knowledge_items` row may leave CANDIDATE only with a
  human `reviewed_by` (null or `agent…` is refused).
* RLS is enabled on every table with a permissive policy for the `authenticated` role. There is no auth
  in CT-OS yet (next ticket). A commented-out `anon` policy exists for local development only — do not
  ship it.

## Repository behaviour (`src/services/supabase/repository.ts`)

* `load()` reads all 20 tables and assembles `OSData`. If `projects` is empty the database is
  considered fresh: the U-Proof seed is returned and `bootstrapped = true`; the first `persist()`
  writes it. So a new database starts exactly like the in-memory app.
* `persist(data)` diffs each table against the last state known to be in the database (per row,
  deterministic JSON) and upserts only new/changed rows in FK order, then deletes removed ids in
  reverse order. Calls are queued and coalesced: a burst of reducer actions becomes one write round.
* It talks to a narrow `SupabaseClientLike` interface. The real client is created in
  `src/services/supabase/client.ts` (the only file importing `@supabase/supabase-js`, loaded lazily);
  `FakeSupabaseClient` implements the same interface in memory for tests.
* `lastError` and `describe()` feed the Settings screen.

## Choosing a repository (`createRepository()`)

| `VITE_CTOS_REPOSITORY` | URL + key present | Result |
|---|---|---|
| `auto` (default) | yes | Supabase |
| `auto` | no | In-memory, reason shown in Settings |
| `memory` | any | In-memory |
| `supabase` | no | In-memory with an explicit "not set" reason |
| `supabase` | yes | Supabase |

If Supabase is chosen but `load()` throws (network, RLS, missing migration), `OSStoreProvider` falls
back to the in-memory seed and shows the error reason in Settings; the app keeps working.

## Setting it up

1. Create a Supabase project. Run `supabase/migrations/0001_ctos_core.sql` in the SQL editor (or
   `supabase db push`).
2. Copy `.env.example` → `.env.local`; set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. Until auth exists, either sign in a user through Supabase Auth in the browser session, or (local dev
   only) enable the commented `anon` policy.
4. Start the app; Settings shows "Supabase". The first load seeds U-Proof.

## Known limits (Phase 1)

* Full-snapshot diffing is O(rows) per persist; fine at agency scale, replaced by per-action writes
  when the API layer exists.
* No realtime subscriptions; another browser will not see changes until reload.
* No auth, so no `user_id`/audit columns yet. `reviewed_by`, `decided_by` and `actor` are plain text
  ("Production Lead") until identities arrive.
* `artifacts.content` is stored as-is; schema validation per `type@schemaVersion` is a follow-up.

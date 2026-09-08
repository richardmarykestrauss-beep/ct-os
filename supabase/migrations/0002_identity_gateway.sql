-- Creative Touch Website OS — CTOS-002: identity, job approvals, execution logs
-- Applies on top of 0001_ctos_core.sql.

-- ---------------------------------------------------------------- profiles (auth identity → role)
-- CTOS-002A: added `active`. A profile with active = false is inert — it cannot read or write
-- anything (see ctos_active() and the RLS policies below) even though the Supabase Auth session is
-- perfectly valid. This is how self-registered sign-ups with no invite are neutralised without
-- needing to touch Supabase Auth configuration itself. See "Sign-up and activation" in
-- docs/AUTH-AND-PERMISSIONS.md.
create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text not null,
  role         text not null default 'VIEWER' check (role in ('ADMIN','PRODUCTION_LEAD','TEAM_MEMBER','VIEWER')),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table profiles add column if not exists active boolean not null default true;

-- Invite-only account activation (CTOS-002A). An ADMIN (or PRODUCTION_LEAD) rows one of these before
-- the invited person signs up; the sign-up trigger below matches on email and consumes it. No invite
-- → the account is created but inactive (see ctos_handle_new_user). There is intentionally no
-- privileged read/write API for this table from the browser beyond what RLS grants below — invites
-- are managed by an ADMIN directly (SQL editor or a future admin screen), which keeps this patch from
-- growing a full user-management UI it wasn't asked to build.
create table if not exists invites (
  id          text primary key,
  email       text not null,
  role        text not null check (role in ('ADMIN','PRODUCTION_LEAD','TEAM_MEMBER','VIEWER')),
  invited_by  uuid references profiles(id),
  created_at  timestamptz not null default now(),
  used_at     timestamptz,
  used_by     uuid references profiles(id),
  expires_at  timestamptz
);
-- Only one *live* (unused) invite per email at a time — matches resolveSignup() in
-- src/services/signup-policy.ts, which picks the single unused/unexpired match.
create unique index if not exists invites_email_live_idx on invites (lower(email)) where used_at is null;

-- Role of the calling user (security definer so RLS policies can consult it without recursion).
-- Always returns a role even for an inactive profile — callers MUST also check ctos_active(); the
-- generic read/write policies below do, but a future policy that forgets to would otherwise silently
-- treat an inactive account as a normal VIEWER.
create or replace function ctos_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from profiles where id = auth.uid()), 'VIEWER');
$$;

-- Whether the calling user's account is usable at all. false for: no profile row, or a profile with
-- active = false (an unapproved self-registration, or one an ADMIN has since deactivated).
create or replace function ctos_active() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select active from profiles where id = auth.uid()), false);
$$;

-- Auto-create a profile on sign-up (CTOS-002A rewrite). Registration order NEVER grants a role any
-- more — there is no "first user" special case, because relying on who happens to register first is
-- not a safe bootstrap for a production instance. Instead:
--   * A live invite matching this email (see `invites` above) assigns its role and is consumed —
--     the account is active immediately.
--   * No matching invite → the profile is created as an inactive VIEWER. The person has a valid
--     Supabase session but ctos_active() is false, so every RLS policy below refuses them, and the
--     gateway (SupabaseGatewayAuth.verify) refuses them independently. An ADMIN activates them later
--     by setting profiles.active = true (and, if needed, a real role) from the SQL editor or a future
--     admin screen.
-- This logic is mirrored (and unit-tested, since there is no local Postgres harness here) in
-- src/services/signup-policy.ts::resolveSignup — keep the two in sync.
create or replace function ctos_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare inv record; assigned_role text; is_active boolean;
begin
  select * into inv from invites
    where lower(email) = lower(coalesce(new.email, ''))
      and used_at is null
      and (expires_at is null or expires_at > now())
    order by created_at desc
    limit 1;
  if inv.id is not null then
    assigned_role := inv.role;
    is_active := true;
    update invites set used_at = now(), used_by = new.id where id = inv.id;
  else
    assigned_role := 'VIEWER';
    is_active := false;
  end if;
  insert into profiles (id, email, display_name, role, active)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(coalesce(new.email, 'user'), '@', 1)),
    assigned_role,
    is_active
  )
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function ctos_handle_new_user();

-- Only ADMIN may change roles or activation state; users may edit their own display name.
create or replace function ctos_guard_profile_update() returns trigger
language plpgsql as $$
begin
  if (new.role is distinct from old.role or new.active is distinct from old.active) and ctos_role() <> 'ADMIN' and auth.uid() is not null then
    raise exception 'Only an ADMIN can change roles or activation state';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists profiles_guard_update on profiles;
create trigger profiles_guard_update before update on profiles
  for each row execute function ctos_guard_profile_update();

-- ---------------------------------------------------------------- identity columns on existing tables
alter table approvals       add column if not exists decided_by_id   uuid references profiles(id);
alter table activity_events add column if not exists actor_id        uuid references profiles(id);
alter table knowledge_items add column if not exists reviewed_by_id  uuid references profiles(id);
alter table agent_lessons   add column if not exists reviewed_by_id  uuid references profiles(id);
alter table agent_jobs      add column if not exists requested_by_id uuid references profiles(id);

-- Execution lease (one execution at a time per job; set/cleared by the gateway only).
alter table agent_jobs add column if not exists execution_claim_id  text;
alter table agent_jobs add column if not exists execution_claimed_at timestamptz;

-- Permission tiers and provider policy are ADMIN-only to edit; a client can never lower a job's tier
-- below its agent's. Without this, a TEAM_MEMBER could rewrite a tier through PostgREST and bypass approval.
create or replace function ctos_guard_agent_update() returns trigger language plpgsql as $$
begin
  if auth.uid() is null then return new; end if;
  if (new.permission_level is distinct from old.permission_level or new.can_execute_site_changes is distinct from old.can_execute_site_changes) and ctos_role() <> 'ADMIN' then
    raise exception 'Only an ADMIN can change an agent''s permission tier';
  end if;
  if new.provider_policy is distinct from old.provider_policy and ctos_role() not in ('ADMIN','PRODUCTION_LEAD') then
    raise exception 'Only an ADMIN or PRODUCTION_LEAD can change an agent''s provider policy';
  end if;
  return new;
end $$;
drop trigger if exists agents_guard_update on agents;
create trigger agents_guard_update before update on agents
  for each row execute function ctos_guard_agent_update();

create or replace function ctos_guard_job_write() returns trigger language plpgsql as $$
declare agent_level text; rank_job int; rank_agent int;
begin
  if auth.uid() is null then return new; end if;
  select permission_level into agent_level from agents where id = new.agent_id;
  rank_job := case new.permission_level when 'GREEN' then 0 when 'AMBER' then 1 else 2 end;
  rank_agent := case agent_level when 'GREEN' then 0 when 'AMBER' then 1 else 2 end;
  if rank_job < rank_agent then
    raise exception 'A job cannot carry a lower permission tier (%) than its agent (%)', new.permission_level, agent_level;
  end if;
  -- Clients never touch the execution lease.
  if TG_OP = 'UPDATE' then
    new.execution_claim_id := old.execution_claim_id;
    new.execution_claimed_at := old.execution_claimed_at;
  else
    new.execution_claim_id := null;
    new.execution_claimed_at := null;
  end if;
  return new;
end $$;
drop trigger if exists agent_jobs_guard_write on agent_jobs;
create trigger agent_jobs_guard_write before insert or update on agent_jobs
  for each row execute function ctos_guard_job_write();

-- ---------------------------------------------------------------- run validation fields
alter table agent_runs add column if not exists error_category text;
alter table agent_runs add column if not exists validation     jsonb;
alter table agent_runs add column if not exists latency_ms     integer;
-- status now also allows FAILED_VALIDATION (text column, no enum change needed)

-- ---------------------------------------------------------------- job approvals (AMBER) / authorizations (RED)
create table if not exists job_approvals (
  id                 text primary key,
  job_id             text not null references agent_jobs(id) on delete cascade,
  project_id         text not null references projects(id) on delete cascade,
  agent_id           text not null references agents(id),
  kind               text not null check (kind in ('APPROVAL','AUTHORIZATION')),
  permission_level   text not null check (permission_level in ('GREEN','AMBER','RED')),
  action_fingerprint text not null,
  requested_action   text not null,
  requested_by_id    uuid not null,
  requested_by_name  text not null,
  approved_by_id     uuid,
  approved_by_name   text,
  approved_by_role   text,
  status             text not null check (status in ('PENDING','APPROVED','REJECTED','CONSUMED','EXPIRED')),
  note               text,
  created_at         timestamptz,
  decided_at         timestamptz,
  consumed_at        timestamptz,
  expires_at         timestamptz
);
create index if not exists job_approvals_job_idx on job_approvals(job_id, status);

-- Approval integrity: only leads/admins approve; an AUTHORIZATION is self-issued by a lead/admin.
create or replace function ctos_guard_job_approval() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null then return new; end if; -- service role (gateway) is trusted
  -- The client may mirror a gateway consumption (APPROVED → CONSUMED) as long as nothing else changes.
  if TG_OP = 'UPDATE' and old.status in ('APPROVED','CONSUMED') and new.status = 'CONSUMED'
     and new.approved_by_id is not distinct from old.approved_by_id
     and new.approved_by_role is not distinct from old.approved_by_role
     and new.action_fingerprint = old.action_fingerprint and new.job_id = old.job_id and new.kind = old.kind then
    return new;
  end if;
  if new.status in ('APPROVED','CONSUMED') then
    if new.approved_by_id is distinct from auth.uid() then
      raise exception 'approved_by_id must be the current user';
    end if;
    if ctos_role() not in ('ADMIN','PRODUCTION_LEAD') then
      raise exception 'Only ADMIN or PRODUCTION_LEAD may approve or authorize';
    end if;
    new.approved_by_role := ctos_role();
  end if;
  if new.kind = 'AUTHORIZATION' and new.requested_by_id is distinct from auth.uid() then
    raise exception 'A RED authorization is issued by the executing user for themselves';
  end if;
  return new;
end $$;
drop trigger if exists job_approvals_guard on job_approvals;
create trigger job_approvals_guard before insert or update on job_approvals
  for each row execute function ctos_guard_job_approval();

-- ---------------------------------------------------------------- execution logs (gateway-only writes)
create table if not exists execution_logs (
  id               text primary key,
  job_id           text not null references agent_jobs(id) on delete cascade,
  run_id           text references agent_runs(id) on delete set null,
  project_id       text not null references projects(id) on delete cascade,
  agent_id         text not null references agents(id),
  provider_id      text,
  model            text,
  status           text not null check (status in ('COMPLETED','FAILED','FAILED_VALIDATION','REJECTED','SKIPPED')),
  fallback_index   integer not null default 0,
  permission_check jsonb not null,
  validation       jsonb,
  artifact_id      text references artifacts(id),
  error_category   text,
  error_message    text,
  usage            jsonb,
  latency_ms       integer,
  requested_by_id  uuid,
  raw_output       jsonb,   -- only populated when validation failed; never secrets
  started_at       timestamptz,
  finished_at      timestamptz
);
create index if not exists execution_logs_job_idx on execution_logs(job_id);

-- ---------------------------------------------------------------- RLS
alter table profiles       enable row level security;
alter table invites        enable row level security;
alter table job_approvals  enable row level security;
alter table execution_logs enable row level security;

-- profiles (CTOS-002A: was `using (true)` — every authenticated user, including every email address,
-- could read every profile. Now: your own row always (even while inactive, so the app can show the
-- "waiting for approval" screen), or an ADMIN's full read of everyone. Nobody else sees anyone else's
-- profile, email included. See "Profile privacy" in docs/AUTH-AND-PERMISSIONS.md.)
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select to authenticated
  using (id = auth.uid() or (ctos_active() and ctos_role() = 'ADMIN'));
drop policy if exists profiles_update_own on profiles;
create policy profiles_update_own on profiles for update to authenticated
  using (id = auth.uid() or (ctos_active() and ctos_role() = 'ADMIN'))
  with check (id = auth.uid() or (ctos_active() and ctos_role() = 'ADMIN'));

-- invites: ADMIN-only in every direction. Contains the email addresses of people who have not yet
-- signed up — nobody else has a reason to see this table.
drop policy if exists invites_admin_all on invites;
create policy invites_admin_all on invites for all to authenticated
  using (ctos_active() and ctos_role() = 'ADMIN') with check (ctos_active() and ctos_role() = 'ADMIN');

-- job_approvals: read requires an active account (an inactive one sees nothing). Insert/update stay
-- open to any active non-VIEWER — ctos_guard_job_approval() above already restricts who may actually
-- move a row to APPROVED/CONSUMED/AUTHORIZATION. Delete is ADMIN-only (CTOS-002A: previously any
-- non-VIEWER could delete any approval row, including one requested or decided by someone else).
drop policy if exists job_approvals_read on job_approvals;
create policy job_approvals_read on job_approvals for select to authenticated using (ctos_active());
drop policy if exists job_approvals_write on job_approvals;
drop policy if exists job_approvals_insert on job_approvals;
create policy job_approvals_insert on job_approvals for insert to authenticated with check (ctos_active() and ctos_role() <> 'VIEWER');
drop policy if exists job_approvals_update on job_approvals;
create policy job_approvals_update on job_approvals for update to authenticated using (ctos_active() and ctos_role() <> 'VIEWER') with check (ctos_active() and ctos_role() <> 'VIEWER');
drop policy if exists job_approvals_delete on job_approvals;
create policy job_approvals_delete on job_approvals for delete to authenticated using (ctos_active() and ctos_role() = 'ADMIN');

-- Execution logs: readable by an active ADMIN or PRODUCTION_LEAD; written only by the gateway
-- (service role bypasses RLS) — there is still no insert/update/delete policy for authenticated
-- users at all, so this table stays gateway-only end to end.
drop policy if exists execution_logs_read on execution_logs;
create policy execution_logs_read on execution_logs for select to authenticated using (ctos_active() and ctos_role() in ('ADMIN','PRODUCTION_LEAD'));
drop policy if exists execution_logs_delete on execution_logs;
create policy execution_logs_delete on execution_logs for delete to authenticated using (ctos_active() and ctos_role() = 'ADMIN');

-- ---------------------------------------------------------------- everything else: read / insert+update / delete
-- CTOS-002A: the CTOS-001 tables previously shared one `for all` policy per table (any active
-- non-VIEWER could insert, update AND physically delete). That is split three ways below:
--   * read:          any active authenticated user (was `using (true)` — now also requires
--                     ctos_active(), so an inactive/unapproved account cannot read CT-OS data either).
--   * insert/update: unchanged — any active non-VIEWER.
--   * delete:        ADMIN only for tables that are audit trails, cascade to audit trails, or are
--                     otherwise costly to lose (see access-policy.ts ADMIN_ONLY_DELETE_TABLES for the
--                     per-table reasoning); ADMIN or PRODUCTION_LEAD for routine operational tables
--                     (access-policy.ts LEAD_DELETE_TABLES). TEAM_MEMBER never has a delete policy on
--                     any of these tables — use the existing status/resolved/archival fields instead
--                     (tickets.approvalState, knowledge_items.status, launch_holds.resolved,
--                     qa_runs outcome, etc.) rather than a physical delete.
-- This mirrors src/services/access-policy.ts::canMutate — keep the two in sync.
do $$
declare t text;
begin
  foreach t in array array[
    'clients','projects','project_phases','agents','project_pages','tickets','artifacts','qa_runs','qa_items',
    'launch_holds','gates','approvals','activity_events','agent_jobs','agent_runs','handoffs','knowledge_items',
    'agent_lessons','integrations','project_integrations'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_authenticated_all', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using (ctos_active())', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('create policy %I on %I for insert to authenticated with check (ctos_active() and ctos_role() <> ''VIEWER'')', t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('create policy %I on %I for update to authenticated using (ctos_active() and ctos_role() <> ''VIEWER'') with check (ctos_active() and ctos_role() <> ''VIEWER'')', t || '_update', t);
  end loop;

  -- Delete: ADMIN-only tables (audit trails, cascades onto audit trails, or launch-safety records).
  foreach t in array array[
    'clients','projects','artifacts','agent_runs','activity_events','approvals',
    'knowledge_items','agent_lessons','launch_holds','qa_runs','agent_jobs'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_delete', t);
    execute format('create policy %I on %I for delete to authenticated using (ctos_active() and ctos_role() = ''ADMIN'')', t || '_delete', t);
  end loop;

  -- Delete: routine operational tables — ADMIN or PRODUCTION_LEAD.
  foreach t in array array[
    'project_phases','project_pages','tickets','gates','qa_items','handoffs','integrations','project_integrations'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_delete', t);
    execute format('create policy %I on %I for delete to authenticated using (ctos_active() and ctos_role() in (''ADMIN'',''PRODUCTION_LEAD''))', t || '_delete', t);
  end loop;
end $$;

-- `agents` gets read/insert/update from the loop above like everything else (its sensitive columns —
-- permission_level, can_execute_site_changes, provider_policy — are guarded separately by
-- ctos_guard_agent_update regardless of who can UPDATE the row at all). It wasn't in either delete
-- list above; give it the same ADMIN-only delete as other primary records here.
drop policy if exists agents_delete on agents;
create policy agents_delete on agents for delete to authenticated using (ctos_active() and ctos_role() = 'ADMIN');

-- Knowledge decisions must carry the deciding user (defence in depth for the app rule).
create or replace function ctos_guard_knowledge_review() returns trigger language plpgsql as $$
begin
  if new.scope <> 'TASK' and new.status <> 'CANDIDATE' and (new.reviewed_by is null or new.reviewed_by like 'agent%') then
    raise exception 'knowledge_items.% requires a human reviewed_by (got %)', new.status, new.reviewed_by;
  end if;
  if TG_OP = 'UPDATE' and auth.uid() is not null and new.status is distinct from old.status and new.reviewed_by_id is distinct from auth.uid() then
    raise exception 'knowledge decisions must be recorded under the deciding user';
  end if;
  return new;
end $$;

-- Creative Touch Website OS — CTOS-001 core schema
-- IDs are text (string-safe): seeded readable ids (proj_uproof) and generated <prefix>_<uuid> ids coexist.
-- Unknown historical timestamps are NULL. Never backfill invented dates.
-- Arrays and nested objects are jsonb so the domain model round-trips without join tables in Phase 1.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- clients
create table if not exists clients (
  id            text primary key,
  name          text not null,
  website_url   text,
  contact_name  text,
  contact_email text,
  notes         text,
  created_at    timestamptz,
  updated_at    timestamptz
);

-- ---------------------------------------------------------------- projects
create table if not exists projects (
  id                   text primary key,
  client_id            text not null references clients(id),
  name                 text not null,
  type                 text not null,
  platforms            jsonb not null default '[]'::jsonb,
  platform_summary     text not null,
  domain               text,
  state                text not null,
  status_label         text not null,
  progress             integer not null default 0,
  progress_note        text,
  current_phase        text not null,
  next_action          text not null,
  primary_goal         text,
  has_existing_website boolean,
  notes                text,
  created_at           timestamptz,
  updated_at           timestamptz
);
create index if not exists projects_client_idx on projects(client_id);
create index if not exists projects_state_idx on projects(state);

create table if not exists project_phases (
  id         text primary key,
  project_id text not null references projects(id) on delete cascade,
  key        text not null,
  label      text not null,
  status     text not null,
  "order"    integer not null,
  note       text
);
create index if not exists project_phases_project_idx on project_phases(project_id);

-- ---------------------------------------------------------------- agents
create table if not exists agents (
  id                      text primary key,
  code                    text not null unique,
  short_code              text not null,
  name                    text not null,
  role                    text not null,
  responsibilities        jsonb not null default '[]'::jsonb,
  status                  text not null,
  status_detail           text,
  current_project_id      text references projects(id) on delete set null,
  current_ticket_id       text,
  last_run_at             timestamptz,
  outputs_produced        integer not null default 0,
  provider_policy         jsonb not null,          -- { preferred, fallbacks[], reviewer }
  permission_level        text not null,           -- GREEN | AMBER | RED
  required_capabilities   jsonb not null default '[]'::jsonb,
  produces_artifact_types jsonb not null default '[]'::jsonb,
  consumes_artifact_types jsonb not null default '[]'::jsonb,
  can_execute_site_changes boolean not null default false,
  created_at              timestamptz,
  updated_at              timestamptz
);

-- ---------------------------------------------------------------- pages
create table if not exists project_pages (
  id           text primary key,
  project_id   text not null references projects(id) on delete cascade,
  title        text not null,
  type         text not null,
  build_status text not null,
  qa_status    text not null,
  wp_ref_kind  text not null,
  wp_ref_id    integer,
  hold_note    text,
  notes        text,
  ticket_id    text,
  updated_at   timestamptz
);
create index if not exists project_pages_project_idx on project_pages(project_id);

-- ---------------------------------------------------------------- tickets
create table if not exists tickets (
  id               text primary key,
  code             text not null,
  project_id       text not null references projects(id) on delete cascade,
  title            text not null,
  agent_id         text not null references agents(id),
  phase            text not null,
  status           text not null,
  priority         text not null,
  objective        text not null,
  environment      text not null,
  scope            jsonb not null default '[]'::jsonb,
  do_not_change    jsonb not null default '[]'::jsonb,
  execution_output text,
  safety_check     text,
  warnings         jsonb not null default '[]'::jsonb,
  approval_state   text not null,
  "order"          integer not null,
  created_at       timestamptz,
  updated_at       timestamptz,
  completed_at     timestamptz
);
create index if not exists tickets_project_idx on tickets(project_id);
create index if not exists tickets_agent_idx on tickets(agent_id);

-- ---------------------------------------------------------------- artifacts (versioned)
create table if not exists artifacts (
  id                     text primary key,
  project_id             text not null references projects(id) on delete cascade,
  type                   text not null,
  title                  text not null,
  version                integer not null default 1,
  created_by_agent_id    text references agents(id),
  created_by_provider    text,                       -- claude | openai | gemini | null
  ticket_id              text,
  job_id                 text,
  status                 text not null default 'DRAFT', -- DRAFT | FINAL | SUPERSEDED | REJECTED
  storage_location       text,                       -- null = metadata record only
  schema_version         integer not null default 1,
  supersedes_artifact_id text references artifacts(id),
  summary                text,
  content                jsonb,
  created_at             timestamptz,
  updated_at             timestamptz
);
create index if not exists artifacts_project_type_idx on artifacts(project_id, type);
create index if not exists artifacts_supersedes_idx on artifacts(supersedes_artifact_id);

-- ---------------------------------------------------------------- QA
create table if not exists qa_runs (
  id             text primary key,
  project_id     text not null references projects(id) on delete cascade,
  ticket_id      text,
  job_id         text,
  run_by_agent_id text not null references agents(id),
  scope          jsonb not null default '[]'::jsonb,
  result         text not null,                      -- PASS | ISSUES_FOUND | FAIL | INCOMPLETE
  counts         jsonb not null default '{"P0":0,"P1":0,"P2":0,"P3":0}'::jsonb,
  summary        text,
  artifact_id    text references artifacts(id),
  started_at     timestamptz,
  finished_at    timestamptz
);
create index if not exists qa_runs_project_idx on qa_runs(project_id);

create table if not exists qa_items (
  id                text primary key,
  project_id        text not null references projects(id) on delete cascade,
  page_id           text,
  ticket_id         text,
  qa_run_id         text references qa_runs(id),
  title             text not null,
  severity          text not null,
  category          text not null,
  description       text not null,
  assigned_agent_id text references agents(id),
  status            text not null,
  created_at        timestamptz,
  resolved_at       timestamptz
);
create index if not exists qa_items_project_idx on qa_items(project_id);

-- ---------------------------------------------------------------- launch holds (not defects)
create table if not exists launch_holds (
  id          text primary key,
  project_id  text not null references projects(id) on delete cascade,
  page_id     text,
  title       text not null,
  detail      text,
  owner       text not null,
  resolved    boolean not null default false,
  resolved_at timestamptz,
  created_at  timestamptz
);
create index if not exists launch_holds_project_idx on launch_holds(project_id);

-- ---------------------------------------------------------------- gates + approvals
create table if not exists gates (
  id                       text primary key,
  key                      text not null unique,   -- STRATEGY | DESIGN | STAGING_BUILD | LAUNCH
  label                    text not null,
  "order"                  integer not null,
  requires_human_approval  boolean not null default true,
  required_artifact_types  jsonb not null default '[]'::jsonb,
  confirm_on_open_holds    boolean not null default false,
  description              text not null
);

create table if not exists approvals (
  id           text primary key,
  project_id   text not null references projects(id) on delete cascade,
  gate         text not null references gates(key),
  requested_by text not null,
  status       text not null,
  notes        text,
  decided_by   text,
  decided_at   timestamptz,
  created_at   timestamptz
);
create index if not exists approvals_project_idx on approvals(project_id);

-- ---------------------------------------------------------------- activity
create table if not exists activity_events (
  id         text primary key,
  project_id text references projects(id) on delete cascade,
  kind       text not null,
  ref        text,
  message    text not null,
  actor      text not null,
  at         timestamptz,
  "order"    integer not null
);
create index if not exists activity_events_project_order_idx on activity_events(project_id, "order");

-- ---------------------------------------------------------------- agent jobs / runs / handoffs
create table if not exists agent_jobs (
  id                     text primary key,
  project_id             text not null references projects(id) on delete cascade,
  agent_id               text not null references agents(id),
  ticket_id              text,
  task_type              text not null,
  instructions           text not null,
  input_artifact_ids     jsonb not null default '[]'::jsonb,
  available_tool_ids     jsonb not null default '[]'::jsonb,
  required_output_schema text not null,
  required_capabilities  jsonb not null default '[]'::jsonb,
  preferred_provider     text not null,
  fallback_providers     jsonb not null default '[]'::jsonb,
  permission_level       text not null,
  status                 text not null,             -- QUEUED | RUNNING | WAITING_APPROVAL | COMPLETED | FAILED | CANCELLED
  output_artifact_id     text references artifacts(id),
  handoff_id             text,
  error                  text,
  created_at             timestamptz,
  updated_at             timestamptz,
  started_at             timestamptz,
  completed_at           timestamptz
);
create index if not exists agent_jobs_project_status_idx on agent_jobs(project_id, status);

create table if not exists agent_runs (
  id             text primary key,
  job_id         text not null references agent_jobs(id) on delete cascade,
  project_id     text not null references projects(id) on delete cascade,
  agent_id       text not null references agents(id),
  provider_id    text not null,
  model          text,
  attempt        integer not null,
  status         text not null,                     -- RUNNING | SUCCEEDED | FAILED | SKIPPED
  output_summary text,
  error          text,
  input_tokens   integer,
  output_tokens  integer,
  started_at     timestamptz,
  finished_at    timestamptz
);
create index if not exists agent_runs_job_idx on agent_runs(job_id);

create table if not exists handoffs (
  id                   text primary key,
  project_id           text not null references projects(id) on delete cascade,
  source_agent_id      text not null references agents(id),
  destination_agent_id text not null references agents(id),
  input_artifact_ids   jsonb not null default '[]'::jsonb,
  output_artifact_id   text references artifacts(id),
  job_id               text references agent_jobs(id) on delete set null,
  run_id               text references agent_runs(id) on delete set null,
  status               text not null,               -- PENDING | ACCEPTED | IN_PROGRESS | COMPLETED | REJECTED | CANCELLED
  note                 text,
  created_at           timestamptz,
  updated_at           timestamptz
);
create index if not exists handoffs_project_idx on handoffs(project_id);

-- ---------------------------------------------------------------- knowledge
create table if not exists knowledge_items (
  id                   text primary key,
  scope                text not null,               -- DOCTRINE | AGENCY | PROJECT | TASK
  category             text not null,
  title                text not null,
  content              text not null,
  evidence             jsonb not null default '[]'::jsonb,
  confidence           numeric(3,2) not null default 0.5 check (confidence >= 0 and confidence <= 1),
  status               text not null,               -- CANDIDATE | APPROVED | REJECTED | DEPRECATED
  project_id           text references projects(id) on delete cascade,
  job_id               text references agent_jobs(id) on delete cascade,
  proposed_by_agent_id text references agents(id),
  reviewed_by          text,
  reviewed_at          timestamptz,
  created_at           timestamptz,
  updated_at           timestamptz,
  constraint knowledge_scope_project check (
    (scope in ('DOCTRINE','AGENCY') and project_id is null) or
    (scope in ('PROJECT','TASK') and project_id is not null)
  )
);
create index if not exists knowledge_scope_status_idx on knowledge_items(scope, status);

create table if not exists agent_lessons (
  id                 text primary key,
  project_id         text references projects(id) on delete cascade,
  agent_id           text not null references agents(id),
  knowledge_item_id  text not null references knowledge_items(id) on delete cascade,
  proposed_scope     text not null,                 -- AGENCY | PROJECT
  source_artifact_id text references artifacts(id),
  source_job_id      text references agent_jobs(id) on delete set null,
  source             text not null,
  status             text not null,                 -- CANDIDATE | APPROVED | REJECTED
  reviewed_by        text,
  reviewed_at        timestamptz,
  created_at         timestamptz
);
create index if not exists agent_lessons_knowledge_idx on agent_lessons(knowledge_item_id);

-- ---------------------------------------------------------------- integrations
create table if not exists integrations (
  id          text primary key,
  name        text not null,
  plane       text not null,                        -- control | execution | intelligence
  purpose     text not null,
  status      text not null,                        -- NOT_CONNECTED | STUB | CONFIGURED | FUTURE
  provider_id text,
  created_at  timestamptz,
  updated_at  timestamptz
);

create table if not exists project_integrations (
  id              text primary key,
  project_id      text not null references projects(id) on delete cascade,
  integration_id  text not null references integrations(id),
  config          jsonb not null default '{}'::jsonb,   -- non-secret only
  credentials_ref text,                                  -- pointer, never a secret
  status          text not null default 'ACTIVE',
  created_at      timestamptz,
  updated_at      timestamptz,
  unique (project_id, integration_id)
);

-- ---------------------------------------------------------------- guard rails
-- Agents never promote knowledge: only a human reviewer may move an item out of CANDIDATE.
-- The application enforces this; the trigger is defence in depth.
create or replace function ctos_guard_knowledge_review() returns trigger language plpgsql as $$
begin
  -- TASK scope is temporary execution context and may be written by agents.
  if new.scope <> 'TASK' and new.status <> 'CANDIDATE' and (new.reviewed_by is null or new.reviewed_by like 'agent%') then
    raise exception 'knowledge_items.% requires a human reviewed_by (got %)', new.status, new.reviewed_by;
  end if;
  return new;
end $$;
drop trigger if exists knowledge_review_guard on knowledge_items;
create trigger knowledge_review_guard before insert or update on knowledge_items
  for each row execute function ctos_guard_knowledge_review();

-- ---------------------------------------------------------------- RLS
-- RLS is ON for every table. Until CT-OS has auth (next ticket), grant the authenticated role
-- full access; the anon policy below is for LOCAL DEVELOPMENT ONLY and must not ship.
do $$
declare t text;
begin
  foreach t in array array[
    'clients','projects','project_phases','agents','project_pages','tickets','artifacts','qa_runs','qa_items',
    'launch_holds','gates','approvals','activity_events','agent_jobs','agent_runs','handoffs','knowledge_items',
    'agent_lessons','integrations','project_integrations'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_authenticated_all', t);
    execute format('create policy %I on %I for all to authenticated using (true) with check (true)', t || '_authenticated_all', t);
    -- LOCAL DEV ONLY (remove before any shared deployment):
    -- execute format('create policy %I on %I for all to anon using (true) with check (true)', t || '_anon_dev', t);
  end loop;
end $$;

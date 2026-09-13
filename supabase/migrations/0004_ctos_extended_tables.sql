-- Creative Touch Website OS — CTOS-008 extended schema
--
-- Additive only: adds the tables CTOS-005A, CTOS-005B, CTOS-006 and CTOS-007A introduced in the
-- domain model (src/data/types.ts) and the repository mapping (src/services/supabase/mapping.ts)
-- but that never shipped a migration. Until this runs, SupabaseRepository.load() throws on the
-- first missing table (`select("*")` against every entry in TABLES) — Supabase persistence mode is
-- effectively unusable for anything past CTOS-003 without it.
--
-- Column typing: `id text primary key`, camelCase→snake_case per src/services/supabase/mapping.ts
-- toSnake/toRow, and — deliberately — every other column is `jsonb`. The domain model changes
-- frequently and PostgREST/jsonb accepts a string, number, boolean, array, object or null
-- uniformly, so a jsonb column never rejects a value the TS type allows and never needs a
-- follow-up migration when a field's shape changes. This trades index-ability on individual
-- fields (none of these tables are queried by anything but id today — every read is `select *`)
-- for zero schema-drift risk. `created_at`/`updated_at` stay `timestamptz` so ordering ("Unknown
-- historical timestamps are NULL. Never backfill invented dates.") and any future `order by`
-- keep working the same way project/ticket timestamps already do.
--
-- No FOREIGN KEY constraints: several of these ids reference rows across tables added in
-- different tickets (e.g. audit_findings.agent_id vs the agents table), and the app — not the
-- database — owns referential integrity here (see src/services/agent-jobs.ts, website-audit.ts).
-- Indexes are added on the columns every existing query filters by (project_id, job_id, agent_id,
-- audit_request_id) so this stays a deliberate choice, not an oversight.

-- ---------------------------------------------------------------- CTOS-005A: Build & revision control
create table if not exists build_packs (
  id text primary key,
  project_id text,
  version jsonb,
  status jsonb,
  site_blueprint_artifact_id jsonb,
  design_system_artifact_id jsonb,
  content_pack_artifact_id jsonb,
  pages jsonb,
  constraints jsonb,
  permissions jsonb,
  acceptance_criteria jsonb,
  evidence_requirements jsonb,
  conflicts jsonb,
  assembled_by_job_id jsonb,
  assembled_at timestamptz,
  superseded_by_id jsonb,
  created_at timestamptz
);
create index if not exists build_packs_project_idx on build_packs(project_id);

create table if not exists revision_rounds (
  id text primary key,
  project_id text,
  round_number jsonb,
  request_source jsonb,
  ticket_ids jsonb,
  change_request_ids jsonb,
  scope_classification jsonb,
  approved_by_lead_id jsonb,
  approved_by_lead_name jsonb,
  approved_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz
);
create index if not exists revision_rounds_project_idx on revision_rounds(project_id);

create table if not exists change_requests (
  id text primary key,
  project_id text,
  revision_round_id jsonb,
  title jsonb,
  description jsonb,
  classification jsonb,
  recommended_by_agent_id jsonb,
  classified_by_lead_id jsonb,
  classified_by_lead_name jsonb,
  confirmed_at timestamptz,
  ticket_ids jsonb,
  created_at timestamptz
);
create index if not exists change_requests_project_idx on change_requests(project_id);

create table if not exists client_assets (
  id text primary key,
  project_id text,
  name jsonb,
  description jsonb,
  status jsonb,
  file_ref jsonb,
  requested_at timestamptz,
  received_at timestamptz,
  approved_at timestamptz,
  notes jsonb
);
create index if not exists client_assets_project_idx on client_assets(project_id);

create table if not exists curation_candidates (
  id text primary key,
  project_id text,
  agent_id jsonb,
  title jsonb,
  content jsonb,
  evidence_refs jsonb,
  proposed_scope jsonb,
  observed_project_count jsonb,
  confidence jsonb,
  destination_proposal jsonb,
  status jsonb,
  reviewed_by_id jsonb,
  reviewed_by_name jsonb,
  reviewed_at timestamptz,
  created_at timestamptz
);
create index if not exists curation_candidates_project_idx on curation_candidates(project_id);

create table if not exists screenshot_evidence (
  id text primary key,
  project_id text,
  job_id jsonb,
  url jsonb,
  viewport jsonb,
  width_px jsonb,
  height_px jsonb,
  captured_at timestamptz,
  capture_status jsonb,
  console_errors jsonb,
  load_errors jsonb
);
create index if not exists screenshot_evidence_project_idx on screenshot_evidence(project_id);

create table if not exists mode_b_jobs (
  id text primary key,
  job_id text,
  project_id text,
  status jsonb,
  transport jsonb,
  job_pack_hash jsonb,
  job_pack_id jsonb,
  exported_at timestamptz,
  result_imported_at timestamptz,
  result_rejected_reason jsonb,
  operator_id jsonb,
  operator_name jsonb,
  created_at timestamptz
);
create index if not exists mode_b_jobs_project_idx on mode_b_jobs(project_id);
create index if not exists mode_b_jobs_job_idx on mode_b_jobs(job_id);

-- ---------------------------------------------------------------- CTOS-005B: Visual intelligence
create table if not exists visual_references (
  id text primary key,
  project_id text,
  url jsonb,
  title jsonb,
  description jsonb,
  mode jsonb,
  added_by_human jsonb,
  approved_by jsonb,
  approved_at timestamptz,
  created_at timestamptz
);
create index if not exists visual_references_project_idx on visual_references(project_id);

create table if not exists signature_visual_elements (
  id text primary key,
  project_id text,
  description jsonb,
  rationale jsonb,
  status jsonb,
  proposed_by_agent_id jsonb,
  approved_by jsonb,
  approved_at timestamptz,
  created_at timestamptz
);
create index if not exists signature_visual_elements_project_idx on signature_visual_elements(project_id);

create table if not exists section_library (
  id text primary key,
  name jsonb,
  description jsonb,
  category jsonb,
  status jsonb,
  build_strategy jsonb,
  novelty_justification jsonb,
  evidence jsonb,
  approved_by jsonb,
  approved_at timestamptz,
  created_at timestamptz
);

create table if not exists design_token_sets (
  id text primary key,
  project_id text,
  version jsonb,
  tokens jsonb,
  approved_by jsonb,
  approved_at timestamptz,
  created_at timestamptz
);
create index if not exists design_token_sets_project_idx on design_token_sets(project_id);

create table if not exists visual_defects (
  id text primary key,
  project_id text,
  job_id jsonb,
  category jsonb,
  severity jsonb,
  description jsonb,
  evidence jsonb,
  viewport jsonb,
  status jsonb,
  detected_by_agent_id jsonb,
  created_at timestamptz,
  resolved_at timestamptz
);
create index if not exists visual_defects_project_idx on visual_defects(project_id);

create table if not exists design_content_reconciliations (
  id text primary key,
  project_id text,
  description jsonb,
  status jsonb,
  design_artifact_id jsonb,
  content_artifact_id jsonb,
  resolved_by jsonb,
  resolved_at timestamptz,
  created_at timestamptz
);
create index if not exists design_content_reconciliations_project_idx on design_content_reconciliations(project_id);

-- ---------------------------------------------------------------- CTOS-006: WordPress Write Engine / site connections
create table if not exists wp_site_connections (
  id text primary key,
  project_id text,
  site_url jsonb,
  environment jsonb,
  cms jsonb,
  builder jsonb,
  auth_method jsonb,
  credentials_ref jsonb,
  connection_status jsonb,
  last_verified_at timestamptz,
  capabilities jsonb,
  writeable jsonb,
  ownership_note jsonb,
  host_provider jsonb,
  host_replaceable jsonb,
  ct_bridge_status jsonb,
  woo_commerce_status jsonb,
  created_at timestamptz,
  updated_at timestamptz
);
create index if not exists wp_site_connections_project_idx on wp_site_connections(project_id);

create table if not exists website_change_plans (
  id text primary key,
  project_id text,
  site_connection_id jsonb,
  environment jsonb,
  source_request jsonb,
  build_pack_id jsonb,
  elementor_manifest_artifact_id jsonb,
  target_page_id jsonb,
  target_page_title jsonb,
  actions jsonb,
  overall_permission_tier jsonb,
  backup_required jsonb,
  verification_required jsonb,
  screenshot_required jsonb,
  rollback_strategy jsonb,
  human_approvals_required jsonb,
  risks jsonb,
  status jsonb,
  approved_by_id jsonb,
  approved_at timestamptz,
  executing_job_id jsonb,
  created_by_job_id jsonb,
  provenance jsonb,
  created_at timestamptz,
  updated_at timestamptz
);
create index if not exists website_change_plans_project_idx on website_change_plans(project_id);
create index if not exists website_change_plans_site_idx on website_change_plans(site_connection_id);

create table if not exists website_revision_snapshots (
  id text primary key,
  project_id text,
  site_connection_id jsonb,
  page_id jsonb,
  environment jsonb,
  captured_at timestamptz,
  source_revision jsonb,
  elementor_document_ref jsonb,
  page_content_ref jsonb,
  content_hash jsonb,
  originating_job_id jsonb,
  originating_change_plan_id jsonb,
  elementor_snapshot_raw jsonb,
  elementor_snapshot_hash jsonb
);
create index if not exists website_revision_snapshots_project_idx on website_revision_snapshots(project_id);

create table if not exists website_write_results (
  id text primary key,
  change_plan_id text,
  project_id text,
  site_connection_id jsonb,
  status jsonb,
  action_results jsonb,
  before_snapshot_id jsonb,
  after_state_hash jsonb,
  verification_results jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  transport jsonb,
  actor_id jsonb,
  actor_name jsonb,
  errors jsonb,
  rollback_status jsonb,
  provenance jsonb
);
create index if not exists website_write_results_project_idx on website_write_results(project_id);
create index if not exists website_write_results_plan_idx on website_write_results(change_plan_id);

create table if not exists wp_write_audit_log (
  id text primary key,
  project_id text,
  site_connection_id jsonb,
  environment jsonb,
  change_plan_id jsonb,
  write_result_id jsonb,
  requested_by_id jsonb,
  requested_by_name jsonb,
  permission_level jsonb,
  approval_id jsonb,
  action_types jsonb,
  transport jsonb,
  "timestamp" timestamptz,
  before_snapshot_id jsonb,
  result jsonb,
  verification_passed jsonb,
  rollback_performed jsonb
);
create index if not exists wp_write_audit_log_project_idx on wp_write_audit_log(project_id);

create table if not exists wp_idempotency_log (
  id text primary key,
  idempotency_key jsonb,
  change_plan_id text,
  project_id text,
  applied_at timestamptz,
  result_id jsonb
);
create index if not exists wp_idempotency_log_project_idx on wp_idempotency_log(project_id);
create unique index if not exists wp_idempotency_log_key_idx on wp_idempotency_log(idempotency_key);

-- ---------------------------------------------------------------- CTOS-004: External assistant identities
create table if not exists external_clients (
  id text primary key,
  name jsonb,
  type jsonb,
  status jsonb,
  permission_ceiling jsonb,
  allowed_tools jsonb,
  token_hash jsonb,
  token_prefix jsonb,
  created_by_id jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table if not exists external_access_log (
  id text primary key,
  at timestamptz,
  external_client_id text,
  external_client_name jsonb,
  tool jsonb,
  project_id text,
  ctos_user_id jsonb,
  requested_action jsonb,
  permission_tier jsonb,
  result jsonb,
  reason jsonb,
  created_ids jsonb
);
create index if not exists external_access_log_client_idx on external_access_log(external_client_id);
create index if not exists external_access_log_project_idx on external_access_log(project_id);

-- ---------------------------------------------------------------- CTOS-007A: Website Audit Engine
create table if not exists website_audit_requests (
  id text primary key,
  project_id text,
  target_url jsonb,
  audit_type jsonb,
  status jsonb,
  progress_log jsonb,
  audit_job_ids jsonb,
  result_artifact_id jsonb,
  failure_reason jsonb,
  reviewed_at timestamptz,
  requested_by_id jsonb,
  requested_by_name jsonb,
  created_at timestamptz,
  updated_at timestamptz
);
create index if not exists website_audit_requests_project_idx on website_audit_requests(project_id);
create index if not exists website_audit_requests_status_idx on website_audit_requests(status);

create table if not exists audit_findings (
  id text primary key,
  audit_request_id text,
  project_id text,
  agent_id jsonb,
  category jsonb,
  severity jsonb,
  claim_type jsonb,
  title jsonb,
  detail jsonb,
  evidence jsonb,
  business_impact jsonb,
  affected_url jsonb,
  estimated_effort jsonb,
  recommendation jsonb,
  service_opportunity jsonb,
  kind jsonb,
  contributors jsonb,
  source_finding_ids jsonb,
  affected_urls jsonb,
  qa_status jsonb,
  created_at timestamptz
);
create index if not exists audit_findings_request_idx on audit_findings(audit_request_id);
create index if not exists audit_findings_project_idx on audit_findings(project_id);

-- ---------------------------------------------------------------- RLS
-- Same shape as the CTOS-002A policy split in 0002_identity_gateway.sql: read = any active
-- authenticated user; insert/update = active non-VIEWER; delete = ADMIN (or ADMIN/PRODUCTION_LEAD
-- for routine operational tables). external_clients/external_access_log carry bearer-token hashes
-- and cross-project call history — ADMIN-only in every direction, matching the `invites` table.
do $$
declare t text;
begin
  foreach t in array array[
    'build_packs','revision_rounds','change_requests','client_assets','curation_candidates',
    'screenshot_evidence','mode_b_jobs','visual_references','signature_visual_elements',
    'section_library','design_token_sets','visual_defects','design_content_reconciliations',
    'wp_site_connections','website_change_plans','website_revision_snapshots','website_write_results',
    'wp_write_audit_log','wp_idempotency_log','website_audit_requests','audit_findings'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using (ctos_active())', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('create policy %I on %I for insert to authenticated with check (ctos_active() and ctos_role() <> ''VIEWER'')', t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('create policy %I on %I for update to authenticated using (ctos_active() and ctos_role() <> ''VIEWER'') with check (ctos_active() and ctos_role() <> ''VIEWER'')', t || '_update', t);
    execute format('drop policy if exists %I on %I', t || '_delete', t);
    execute format('create policy %I on %I for delete to authenticated using (ctos_active() and ctos_role() in (''ADMIN'',''PRODUCTION_LEAD''))', t || '_delete', t);
  end loop;

  -- External assistant identities and their call log: ADMIN-only, every direction.
  foreach t in array array['external_clients','external_access_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_admin_all', t);
    execute format('create policy %I on %I for all to authenticated using (ctos_active() and ctos_role() = ''ADMIN'') with check (ctos_active() and ctos_role() = ''ADMIN'')', t || '_admin_all', t);
  end loop;
end $$;

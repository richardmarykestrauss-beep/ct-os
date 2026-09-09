-- CTOS-003: multi-model intelligence, provider ranking, usage/cost recording, skills.
--
-- Does NOT touch the identity/RLS model CTOS-002/002A established (ctos_active(), ctos_role(),
-- the per-table read/insert/update/delete split, profiles/invites) — every new policy below
-- reuses those functions exactly, so the security posture is additive, never redesigned.
--
-- Additive columns only; nothing here narrows what a previously-valid row could contain, so this
-- migration is safe to apply after 0002 with existing rows intact (all new columns are nullable
-- or carry a default).

-- ---------------------------------------------------------------- agents: Part I (instruction packs)
alter table agents add column if not exists mission text;
alter table agents add column if not exists exclusions jsonb not null default '[]'::jsonb;
alter table agents add column if not exists default_priority text;      -- QUALITY | BALANCED | COST | SPEED
alter table agents add column if not exists instruction_pack_ids jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------- agent_jobs: Part F (priority)
alter table agent_jobs add column if not exists execution_priority text; -- QUALITY | BALANCED | COST | SPEED; null = BALANCED

-- ---------------------------------------------------------------- agent_runs: Part F/G/L (why, usage, skills)
alter table agent_runs add column if not exists total_tokens integer;
alter table agent_runs add column if not exists estimated_cost_usd numeric;
alter table agent_runs add column if not exists selection_reason text;
alter table agent_runs add column if not exists skill_ids jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------- execution_logs: Part F/L
alter table execution_logs add column if not exists selection_reason text;
alter table execution_logs add column if not exists skill_ids jsonb not null default '[]'::jsonb;
-- execution_logs.usage is already jsonb (0002) — total_tokens/estimated_cost_usd land inside it,
-- same as the other usage fields; no column change needed there.

-- ---------------------------------------------------------------- skills (Parts I, J, K, L)
-- One versioned, approvable resource covers both "instruction pack" (Part I) and "skill" (Parts
-- J/K) — see src/services/skills.ts and docs/SKILL-SYSTEM.md for why this is one table, not two.
create table if not exists skills (
  id                  text primary key,
  name                text not null,
  version             integer not null default 1,
  kind                text not null,                 -- instruction_pack | design_review | build_practice | other
  status              text not null default 'DRAFT', -- DRAFT | CANDIDATE | APPROVED | DEPRECATED
  scope               text not null,
  owner_agent_ids     jsonb not null default '[]'::jsonb,
  reviewer_agent_ids  jsonb not null default '[]'::jsonb,
  content             text not null,
  evidence            jsonb not null default '[]'::jsonb,
  supersedes_id       text references skills(id) on delete set null,
  approved_by         text,
  approved_by_id      uuid,
  approved_at         timestamptz,
  created_at          timestamptz,
  updated_at          timestamptz
);
create index if not exists skills_status_idx on skills(status);

-- Only a human may move a skill into APPROVED — same defence-in-depth pattern as
-- ctos_guard_knowledge_review (0001): the application (services/skills.ts#reviewSkill) already
-- refuses this for a non-human/non-privileged actor; the trigger is the second line of defence.
create or replace function ctos_guard_skill_review() returns trigger language plpgsql as $$
begin
  if new.status = 'APPROVED' and (new.approved_by is null or new.approved_by like 'agent%') then
    raise exception 'skills.status = APPROVED requires a human approved_by (got %)', new.approved_by;
  end if;
  if TG_OP = 'UPDATE' and auth.uid() is not null and new.status is distinct from old.status and new.status = 'APPROVED' and new.approved_by_id is distinct from auth.uid() then
    raise exception 'skill approval must be recorded under the approving user';
  end if;
  return new;
end $$;
drop trigger if exists skill_review_guard on skills;
create trigger skill_review_guard before insert or update on skills
  for each row execute function ctos_guard_skill_review();

-- ---------------------------------------------------------------- RLS: skills
-- Same three-way split CTOS-002A gave every other table: read requires only activation; insert
-- and update require an active non-VIEWER; delete is ADMIN-only, same tier as knowledge_items
-- (skills are reviewed institutional content — rejecting/deprecating is a status change, not a
-- delete; see src/services/access-policy.ts ADMIN_ONLY_DELETE_TABLES, which lists "skills" too).
alter table skills enable row level security;

drop policy if exists skills_read on skills;
create policy skills_read on skills for select to authenticated using (ctos_active());

drop policy if exists skills_insert on skills;
create policy skills_insert on skills for insert to authenticated with check (ctos_active() and ctos_role() <> 'VIEWER');

drop policy if exists skills_update on skills;
create policy skills_update on skills for update to authenticated using (ctos_active() and ctos_role() <> 'VIEWER') with check (ctos_active() and ctos_role() <> 'VIEWER');

drop policy if exists skills_delete on skills;
create policy skills_delete on skills for delete to authenticated using (ctos_active() and ctos_role() = 'ADMIN');

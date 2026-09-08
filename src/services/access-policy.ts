/**
 * Row mutation policy (CTOS-002A).
 *
 * Pure mirror of the per-table RLS policies in supabase/migrations/0002_identity_gateway.sql. The
 * real enforcement is the database (RLS is what actually stops a PostgREST call); this module is a
 * single, testable place to state the rule so a regression here is caught before it drifts from the
 * SQL, and so the UI can hide actions consistently with what the server will actually allow.
 *
 * The model (deliberately not a full RBAC system):
 *  - VIEWER: read-only, always.
 *  - An inactive account (see signup-policy.ts / AuthUser.active): nothing, not even reads.
 *  - insert/update: any active non-VIEWER role, on every table CT-OS writes to.
 *  - delete: narrowed per table. Tables that are audit trails, cascade to audit trails, or are
 *    otherwise expensive to lose physically are ADMIN-only; everyday operational tables also allow
 *    PRODUCTION_LEAD. TEAM_MEMBER never has a delete policy — use status/archive fields instead
 *    (tickets, knowledge_items, launch_holds and qa_runs already carry a status/resolved field for
 *    exactly this reason).
 */
import type { UserRole } from "@/data/types";

export type MutationOp = "insert" | "update" | "delete";

/**
 * Physical DELETE restricted to ADMIN. Reasoning per table:
 *  - projects, clients: primary business records.
 *  - artifacts, agent_runs, activity_events, approvals, execution_logs: history/audit trails.
 *  - knowledge_items, agent_lessons: reviewed institutional knowledge — rejection is a status change,
 *    not a delete.
 *  - launch_holds, qa_runs: launch-safety record; must not quietly disappear.
 *  - agent_jobs, job_approvals: deleting a job cascades (FK on delete cascade) to its job_approvals
 *    and execution_logs — an accidental TEAM_MEMBER/PRODUCTION_LEAD delete here would silently erase
 *    the audit trail for an execution, so this is ADMIN-only even though "job" sounds operational.
 */
export const ADMIN_ONLY_DELETE_TABLES = [
  "projects",
  "clients",
  "agents",
  "artifacts",
  "agent_runs",
  "activity_events",
  "approvals",
  "knowledge_items",
  "agent_lessons",
  "launch_holds",
  "qa_runs",
  "agent_jobs",
  "job_approvals",
  "execution_logs",
] as const;

/** Routine operational tables where PRODUCTION_LEAD may also delete, in addition to ADMIN. */
export const LEAD_DELETE_TABLES = ["project_phases", "project_pages", "tickets", "gates", "qa_items", "handoffs", "integrations", "project_integrations"] as const;

export type PolicyTable = (typeof ADMIN_ONLY_DELETE_TABLES)[number] | (typeof LEAD_DELETE_TABLES)[number];

export const ALL_POLICY_TABLES: readonly PolicyTable[] = [...ADMIN_ONLY_DELETE_TABLES, ...LEAD_DELETE_TABLES];

/** Whether `role` (given `active`) may perform `op` on `table`. */
export function canMutate(role: UserRole, active: boolean, table: PolicyTable, op: MutationOp): boolean {
  if (!active) return false;
  if (role === "VIEWER") return false;
  if (op !== "delete") return true;
  if (role === "ADMIN") return true;
  if (role === "PRODUCTION_LEAD") return (LEAD_DELETE_TABLES as readonly string[]).includes(table);
  return false; // TEAM_MEMBER: no delete, anywhere.
}

export function canRead(active: boolean): boolean {
  return active;
}

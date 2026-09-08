/**
 * Domain ⇄ row mapping for the Supabase repository.
 *
 * Domain objects are camelCase; tables are snake_case. Arrays and nested objects are jsonb and
 * pass through untouched. Optional domain fields (`field?: T`) are stored as NULL and dropped
 * again on the way back; fields typed `T | null` are listed per table so a NULL survives as null.
 */
import type { OSData } from "@/data/types";

export type TableName =
  | "clients"
  | "projects"
  | "project_phases"
  | "agents"
  | "project_pages"
  | "tickets"
  | "artifacts"
  | "qa_runs"
  | "qa_items"
  | "launch_holds"
  | "gates"
  | "approvals"
  | "activity_events"
  | "agent_jobs"
  | "agent_runs"
  | "handoffs"
  | "knowledge_items"
  | "agent_lessons"
  | "integrations"
  | "project_integrations";

export interface TableSpec {
  table: TableName;
  key: keyof OSData;
  /** camelCase domain fields whose type includes `null` (NULL must round-trip as null, not undefined). */
  nullable: string[];
}

/** Insert/upsert order respects foreign keys; deletes run in reverse. */
export const TABLES: TableSpec[] = [
  { table: "clients", key: "clients", nullable: ["createdAt"] },
  { table: "projects", key: "projects", nullable: ["createdAt", "updatedAt"] },
  { table: "project_phases", key: "phases", nullable: [] },
  { table: "agents", key: "agents", nullable: ["currentProjectId", "currentTicketId", "lastRunAt", "createdAt", "updatedAt"] },
  { table: "project_pages", key: "pages", nullable: ["wpRefId", "updatedAt"] },
  { table: "tickets", key: "tickets", nullable: ["createdAt", "updatedAt", "completedAt"] },
  { table: "artifacts", key: "artifacts", nullable: ["createdByAgentId", "createdByProvider", "storageLocation", "supersedesArtifactId", "createdAt", "updatedAt"] },
  { table: "qa_runs", key: "qaRuns", nullable: ["startedAt", "finishedAt"] },
  { table: "qa_items", key: "qaItems", nullable: ["createdAt", "resolvedAt"] },
  { table: "launch_holds", key: "launchHolds", nullable: ["resolvedAt", "createdAt"] },
  { table: "gates", key: "gates", nullable: [] },
  { table: "approvals", key: "approvals", nullable: ["decidedAt", "createdAt"] },
  { table: "activity_events", key: "activity", nullable: ["projectId", "at"] },
  { table: "agent_jobs", key: "agentJobs", nullable: ["outputArtifactId", "handoffId", "createdAt", "updatedAt", "startedAt", "completedAt"] },
  { table: "agent_runs", key: "agentRuns", nullable: ["model", "inputTokens", "outputTokens", "startedAt", "finishedAt"] },
  { table: "handoffs", key: "handoffs", nullable: ["outputArtifactId", "jobId", "runId", "createdAt", "updatedAt"] },
  { table: "knowledge_items", key: "knowledgeItems", nullable: ["projectId", "jobId", "proposedByAgentId", "reviewedBy", "reviewedAt", "createdAt", "updatedAt"] },
  { table: "agent_lessons", key: "agentLessons", nullable: ["projectId", "sourceArtifactId", "sourceJobId", "reviewedBy", "reviewedAt", "createdAt"] },
  { table: "integrations", key: "integrations", nullable: ["createdAt", "updatedAt"] },
  { table: "project_integrations", key: "projectIntegrations", nullable: ["credentialsRef", "createdAt", "updatedAt"] },
];

export function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export type Row = Record<string, unknown>;

/** Domain object → row. `undefined` becomes NULL so upserts clear a field that was removed. */
export function toRow(entity: object): Row {
  const row: Row = {};
  for (const [k, v] of Object.entries(entity)) row[toSnake(k)] = v === undefined ? null : v;
  return row;
}

/** Row → domain object. NULL becomes `undefined` unless the field is declared nullable for the table. */
export function fromRow<T extends object>(spec: TableSpec, row: Row): T {
  const nullable = new Set(spec.nullable);
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    const key = toCamel(k);
    if (v === null && !nullable.has(key)) continue;
    // numeric(3,2) comes back as a string from PostgREST.
    out[key] = key === "confidence" && typeof v === "string" ? Number(v) : v;
  }
  return out as T;
}

export function specFor(table: TableName): TableSpec {
  const spec = TABLES.find((t) => t.table === table);
  if (!spec) throw new Error(`Unknown table ${table}`);
  return spec;
}

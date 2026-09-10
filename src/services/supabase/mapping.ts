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
  | "project_integrations"
  | "job_approvals"
  | "execution_logs"
  | "skills"
  | "external_clients"
  | "external_access_log"
  | "build_packs"
  | "revision_rounds"
  | "change_requests"
  | "client_assets"
  | "curation_candidates"
  | "screenshot_evidence"
  | "mode_b_jobs"
  | "visual_references"
  | "signature_visual_elements"
  | "section_library"
  | "design_token_sets"
  | "visual_defects"
  | "design_content_reconciliations";

export interface TableSpec {
  table: TableName;
  key: keyof OSData;
  /** camelCase domain fields whose type includes `null` (NULL must round-trip as null, not undefined). */
  nullable: string[];
  /** Written only by the gateway (service role). The client reads it and never upserts/deletes. */
  serverOwned?: boolean;
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
  { table: "approvals", key: "approvals", nullable: ["decidedById", "decidedAt", "createdAt"] },
  { table: "activity_events", key: "activity", nullable: ["projectId", "actorId", "at"] },
  { table: "agent_jobs", key: "agentJobs", nullable: ["outputArtifactId", "handoffId", "requestedById", "createdAt", "updatedAt", "startedAt", "completedAt"] },
  { table: "agent_runs", key: "agentRuns", nullable: ["model", "errorCategory", "validation", "latencyMs", "inputTokens", "outputTokens", "totalTokens", "estimatedCostUsd", "selectionReason", "startedAt", "finishedAt"] },
  { table: "handoffs", key: "handoffs", nullable: ["outputArtifactId", "jobId", "runId", "createdAt", "updatedAt"] },
  { table: "knowledge_items", key: "knowledgeItems", nullable: ["projectId", "jobId", "proposedByAgentId", "reviewedBy", "reviewedById", "reviewedAt", "createdAt", "updatedAt"] },
  { table: "agent_lessons", key: "agentLessons", nullable: ["projectId", "sourceArtifactId", "sourceJobId", "reviewedBy", "reviewedById", "reviewedAt", "createdAt"] },
  { table: "integrations", key: "integrations", nullable: ["createdAt", "updatedAt"] },
  { table: "project_integrations", key: "projectIntegrations", nullable: ["credentialsRef", "createdAt", "updatedAt"] },
  { table: "job_approvals", key: "jobApprovals", nullable: ["approvedById", "approvedByName", "approvedByRole", "createdAt", "decidedAt", "consumedAt", "expiresAt"] },
  { table: "execution_logs", key: "executionLogs", nullable: ["runId", "providerId", "model", "validation", "artifactId", "errorCategory", "errorMessage", "usage", "latencyMs", "requestedById", "rawOutput", "selectionReason", "startedAt", "finishedAt"], serverOwned: true },
  { table: "skills", key: "skills", nullable: ["supersedesId", "approvedBy", "approvedById", "approvedAt", "createdAt", "updatedAt"] },
  { table: "external_clients", key: "externalClients", nullable: ["allowedTools", "tokenHash", "tokenPrefix", "createdById", "createdAt", "updatedAt", "lastUsedAt", "revokedAt"] },
  { table: "external_access_log", key: "externalAccessLog", nullable: ["at", "projectId", "ctosUserId", "permissionTier"] },
  // CTOS-005A additions
  { table: "build_packs", key: "buildPacks", nullable: ["assembledByJobId", "supersededById", "assembledAt", "createdAt"] },
  { table: "revision_rounds", key: "revisionRounds", nullable: ["scopeClassification", "approvedByLeadId", "approvedByLeadName", "approvedAt", "completedAt", "createdAt"] },
  { table: "change_requests", key: "changeRequests", nullable: ["recommendedByAgentId", "classifiedByLeadId", "classifiedByLeadName", "confirmedAt", "createdAt"] },
  { table: "client_assets", key: "clientAssets", nullable: ["fileRef", "requestedAt", "receivedAt", "approvedAt", "notes"] },
  { table: "curation_candidates", key: "curationCandidates", nullable: ["projectId", "reviewedById", "reviewedByName", "reviewedAt", "createdAt"] },
  { table: "screenshot_evidence", key: "screenshotEvidence", nullable: [] },
  { table: "mode_b_jobs", key: "modeBJobs", nullable: ["jobPackHash", "jobPackId", "exportedAt", "resultImportedAt", "resultRejectedReason", "operatorId", "operatorName", "createdAt"] },
  // CTOS-005B additions
  { table: "visual_references", key: "visualReferences", nullable: ["approvedAt", "createdAt"] },
  { table: "signature_visual_elements", key: "signatureVisualElements", nullable: ["proposedByAgentId", "approvedBy", "approvedAt", "createdAt"] },
  { table: "section_library", key: "sectionLibrary", nullable: ["noveltyJustification", "approvedBy", "approvedAt", "createdAt"] },
  { table: "design_token_sets", key: "designTokenSets", nullable: ["approvedBy", "approvedAt", "createdAt"] },
  { table: "visual_defects", key: "visualDefects", nullable: ["jobId", "viewport", "detectedByAgentId", "createdAt", "resolvedAt"] },
  { table: "design_content_reconciliations", key: "designContentReconciliations", nullable: ["designArtifactId", "contentArtifactId", "resolvedBy", "resolvedAt", "createdAt"] },
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

/** Columns that exist only for the gateway (leases). Never surfaced to the domain model. */
const SERVER_ONLY_COLUMNS = new Set(["execution_claim_id", "execution_claimed_at"]);

/** Row → domain object. NULL becomes `undefined` unless the field is declared nullable for the table. */
export function fromRow<T extends object>(spec: TableSpec, row: Row): T {
  const nullable = new Set(spec.nullable);
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (SERVER_ONLY_COLUMNS.has(k)) continue;
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

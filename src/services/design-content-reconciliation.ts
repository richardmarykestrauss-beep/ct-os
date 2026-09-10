/**
 * Design↔Content Reconciliation (CTOS-005B Part 17).
 *
 * Tracks open disagreements between A03 (design) and A04 (content) artifacts.
 * Each reconciliation must be RESOLVED before the design quality gate passes (Part 18).
 *
 * Statuses:
 *   OPEN               — conflict identified; not yet resolved
 *   RESOLVED_BY_CONTENT — A04 updated content to match design intent
 *   RESOLVED_BY_DESIGN  — A03 updated composition to accommodate content
 *   NEEDS_HUMAN         — neither agent can resolve; human decision required
 *
 * All functions are pure; no network calls.
 */
import type { DesignContentReconciliation, ISODate, OSData, ReconciliationStatus } from "@/data/types";
import { newId, nowIso } from "@/lib/core";

// ---------------------------------------------------------------------------
// OSData operations
// ---------------------------------------------------------------------------

export interface CreateReconciliationInput {
  projectId: string;
  description: string;
  designArtifactId?: string | null;
  contentArtifactId?: string | null;
  id?: string;
  at?: ISODate;
}

export function createReconciliation(
  data: OSData,
  input: CreateReconciliationInput,
): { data: OSData; reconciliation: DesignContentReconciliation } {
  const at = input.at ?? nowIso();
  const reconciliation: DesignContentReconciliation = {
    id: input.id ?? newId("dcr"),
    projectId: input.projectId,
    description: input.description,
    status: "OPEN",
    designArtifactId: input.designArtifactId ?? null,
    contentArtifactId: input.contentArtifactId ?? null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: at,
  };
  return { data: { ...data, designContentReconciliations: [...data.designContentReconciliations, reconciliation] }, reconciliation };
}

export function resolveReconciliation(
  data: OSData,
  reconciliationId: string,
  status: Exclude<ReconciliationStatus, "OPEN">,
  resolvedBy: string,
  at?: ISODate,
): { data: OSData; reconciliation: DesignContentReconciliation } {
  const existing = data.designContentReconciliations.find((r) => r.id === reconciliationId);
  if (!existing) throw new Error(`DesignContentReconciliation ${reconciliationId} not found`);
  if (existing.status !== "OPEN") throw new Error(`Reconciliation ${reconciliationId} is already ${existing.status}`);
  const reconciliation: DesignContentReconciliation = { ...existing, status, resolvedBy, resolvedAt: at ?? nowIso() };
  return {
    data: { ...data, designContentReconciliations: data.designContentReconciliations.map((r) => (r.id === reconciliationId ? reconciliation : r)) },
    reconciliation,
  };
}

// ---------------------------------------------------------------------------
// Gate helpers
// ---------------------------------------------------------------------------

/** All open reconciliations for a project (blocks design quality gate). */
export function openReconciliations(data: OSData, projectId: string): DesignContentReconciliation[] {
  return data.designContentReconciliations.filter((r) => r.projectId === projectId && r.status === "OPEN");
}

/** True when all reconciliations for a project are resolved. */
export function allReconciled(data: OSData, projectId: string): boolean {
  return openReconciliations(data, projectId).length === 0;
}

/** Reconciliations requiring human input. */
export function needsHumanReconciliations(data: OSData, projectId: string): DesignContentReconciliation[] {
  return data.designContentReconciliations.filter((r) => r.projectId === projectId && r.status === "NEEDS_HUMAN");
}

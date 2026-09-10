/**
 * Visual Defect Model (CTOS-005B Part 20).
 *
 * Typed visual defect categories; canonical severity (P0–P3); OSData operations.
 * A06 uses this to record defects independently of A03/A05 claims (Part 21).
 *
 * All functions are pure; no network calls.
 */
import type { ISODate, OSData, QAItemStatus, QASeverity, ScreenshotViewport, VisualDefect, VisualDefectCategory } from "@/data/types";
import { newId, nowIso } from "@/lib/core";

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/** True when the defect category is layout-structural (vs cosmetic). */
export const STRUCTURAL_CATEGORIES: VisualDefectCategory[] = [
  "LAYOUT", "OVERFLOW", "ALIGNMENT", "RESPONSIVE", "NAVIGATION", "IMPLEMENTATION_MISMATCH",
];

/** True when the defect category is primarily a design/brand concern. */
export const DESIGN_CATEGORIES: VisualDefectCategory[] = [
  "SPACING", "TYPOGRAPHY", "COLOR", "IMAGE", "BRAND", "GENERIC_DESIGN", "ORIGINALITY" as VisualDefectCategory,
];

export function isStructuralDefect(defect: VisualDefect): boolean {
  return STRUCTURAL_CATEGORIES.includes(defect.category);
}

/** True when severity is P0 or P1 — blocks progression. */
export function isBlockingDefect(defect: VisualDefect): boolean {
  return defect.severity === "P0" || defect.severity === "P1";
}

// ---------------------------------------------------------------------------
// OSData operations
// ---------------------------------------------------------------------------

export interface CreateVisualDefectInput {
  projectId: string;
  jobId?: string | null;
  category: VisualDefectCategory;
  severity: QASeverity;
  description: string;
  evidence?: string[];
  viewport?: ScreenshotViewport;
  detectedByAgentId?: string | null;
  id?: string;
  at?: ISODate;
}

export function createVisualDefect(
  data: OSData,
  input: CreateVisualDefectInput,
): { data: OSData; defect: VisualDefect } {
  const at = input.at ?? nowIso();
  const defect: VisualDefect = {
    id: input.id ?? newId("vdef"),
    projectId: input.projectId,
    jobId: input.jobId ?? null,
    category: input.category,
    severity: input.severity,
    description: input.description,
    evidence: input.evidence ?? [],
    ...(input.viewport !== undefined ? { viewport: input.viewport } : {}),
    status: "OPEN" as QAItemStatus,
    detectedByAgentId: input.detectedByAgentId ?? null,
    createdAt: at,
    resolvedAt: null,
  };
  return { data: { ...data, visualDefects: [...data.visualDefects, defect] }, defect };
}

export function resolveVisualDefect(
  data: OSData,
  defectId: string,
  status: Extract<QAItemStatus, "FIXED" | "VERIFIED" | "WONT_FIX">,
  at?: ISODate,
): { data: OSData; defect: VisualDefect } {
  const existing = data.visualDefects.find((d) => d.id === defectId);
  if (!existing) throw new Error(`VisualDefect ${defectId} not found`);
  const defect: VisualDefect = { ...existing, status, resolvedAt: at ?? nowIso() };
  return { data: { ...data, visualDefects: data.visualDefects.map((d) => (d.id === defectId ? defect : d)) }, defect };
}

/** All open (blocking) visual defects for a project. */
export function openBlockingDefects(data: OSData, projectId: string): VisualDefect[] {
  return data.visualDefects.filter(
    (d) => d.projectId === projectId && isBlockingDefect(d) && d.status !== "VERIFIED" && d.status !== "WONT_FIX",
  );
}

/** Summary counts for a project's visual defects by severity. */
export function visualDefectCounts(data: OSData, projectId: string): Record<QASeverity, number> {
  const open = data.visualDefects.filter((d) => d.projectId === projectId && d.status !== "VERIFIED" && d.status !== "WONT_FIX");
  return { P0: 0, P1: 0, P2: 0, P3: 0, ...Object.fromEntries(["P0", "P1", "P2", "P3"].map((s) => [s, open.filter((d) => d.severity === s).length])) } as Record<QASeverity, number>;
}

/**
 * Design Tokens (CTOS-005B Part 14).
 *
 * Manages typed design token sets per project. Tokens cover:
 * colors, typography, spacing, border-radius, shadows, container widths,
 * breakpoints, buttons, forms, image/icon treatment.
 *
 * All functions are pure; no network calls.
 */
import type { DesignToken, DesignTokenKind, DesignTokenSet, ISODate, OSData } from "@/data/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lookup a token by key within a token set. */
export function getToken(set: DesignTokenSet, key: string): DesignToken | undefined {
  return set.tokens.find((t) => t.key === key);
}

/** Filter tokens by kind. */
export function tokensByKind(set: DesignTokenSet, kind: DesignTokenKind): DesignToken[] {
  return set.tokens.filter((t) => t.kind === kind);
}

/** True when a token set has at least one entry for every required kind. */
export const REQUIRED_TOKEN_KINDS: DesignTokenKind[] = ["color", "typography", "spacing"];

export function validateTokenSet(set: DesignTokenSet): { valid: boolean; missingKinds: DesignTokenKind[] } {
  const present = new Set(set.tokens.map((t) => t.kind));
  const missingKinds = REQUIRED_TOKEN_KINDS.filter((k) => !present.has(k));
  return { valid: missingKinds.length === 0, missingKinds };
}

// ---------------------------------------------------------------------------
// OSData operations
// ---------------------------------------------------------------------------

export function createDesignTokenSet(
  data: OSData,
  input: Omit<DesignTokenSet, "approvedBy" | "approvedAt" | "createdAt">,
): { data: OSData; tokenSet: DesignTokenSet } {
  const tokenSet: DesignTokenSet = { ...input, approvedBy: null, approvedAt: null, createdAt: null };
  return { data: { ...data, designTokenSets: [...data.designTokenSets, tokenSet] }, tokenSet };
}

export function approveDesignTokenSet(
  data: OSData,
  setId: string,
  approvedBy: string,
  approvedAt: ISODate,
): { data: OSData; tokenSet: DesignTokenSet } {
  const existing = data.designTokenSets.find((s) => s.id === setId);
  if (!existing) throw new Error(`DesignTokenSet ${setId} not found`);
  const tokenSet: DesignTokenSet = { ...existing, approvedBy, approvedAt };
  return { data: { ...data, designTokenSets: data.designTokenSets.map((s) => (s.id === setId ? tokenSet : s)) }, tokenSet };
}

/** Latest approved design token set for a project, or undefined. */
export function activeDesignTokenSet(data: OSData, projectId: string): DesignTokenSet | undefined {
  return [...data.designTokenSets]
    .filter((s) => s.projectId === projectId && s.approvedBy !== null)
    .sort((a, b) => b.version - a.version)[0];
}

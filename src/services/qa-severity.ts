/**
 * QA severity taxonomy (CTOS-005A Final Pass).
 *
 * Canonical names: CRITICAL | MAJOR | MINOR | COSMETIC
 * Legacy P-codes:  P0      | P1    | P2    | P3
 *
 * P-codes are preserved for backward compatibility with frozen benchmark artifacts
 * and existing QASeverity fields. Normalise to canonical names for new display and logic.
 */
import { QA_SEVERITY_LEVEL } from "@/data/types";
import type { QASeverity, QASeverityLevel } from "@/data/types";

export type { QASeverityLevel };
export { QA_SEVERITY_LEVEL };

const P_CODES = new Set<string>(["P0", "P1", "P2", "P3"]);

/** Normalise a legacy P-code to its canonical severity name. */
export function normalizeToCanonical(severity: QASeverity): QASeverityLevel {
  return QA_SEVERITY_LEVEL[severity];
}

/**
 * Returns true for severities that block review/launch progression.
 * Accepts both legacy P-codes and canonical names.
 */
export function isBlockingSeverity(severity: QASeverity | QASeverityLevel): boolean {
  const canonical: QASeverityLevel = P_CODES.has(severity)
    ? QA_SEVERITY_LEVEL[severity as QASeverity]
    : (severity as QASeverityLevel);
  return canonical === "CRITICAL" || canonical === "MAJOR";
}

/** All four canonical severity levels ordered most-severe first. */
export const CANONICAL_SEVERITY_ORDER: QASeverityLevel[] = ["CRITICAL", "MAJOR", "MINOR", "COSMETIC"];

/** Legacy P-code to canonical name — re-exported for UI consumers. */
export const LEGACY_TO_CANONICAL: Record<QASeverity, QASeverityLevel> = QA_SEVERITY_LEVEL;

/** Canonical name to legacy P-code — for backward-compatible logging. */
export const CANONICAL_TO_LEGACY: Record<QASeverityLevel, QASeverity> = {
  CRITICAL: "P0",
  MAJOR: "P1",
  MINOR: "P2",
  COSMETIC: "P3",
};

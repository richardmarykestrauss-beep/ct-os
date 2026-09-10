/**
 * Evidence-grounded claims (CTOS-005B Part 23).
 *
 * Every claim an agent makes must be typed as one of:
 *   OBSERVED   — directly seen in a screenshot or rendered output
 *   INFERRED   — concluded from observed patterns (must cite observations)
 *   PROPOSED   — not yet verified; requires verification before acting on
 *   VERIFIED   — confirmed by a human or independent agent
 *
 * All functions are pure; no OSData writes.
 */
import type { EvidenceClaim, EvidenceClaimKind } from "@/data/types";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function claim(
  id: string,
  kind: EvidenceClaimKind,
  claimText: string,
  evidence: string[],
  confidence: number,
  madeByAgentId: string | null = null,
  jobId: string | null = null,
): EvidenceClaim {
  if (confidence < 0 || confidence > 1) throw new RangeError(`Confidence must be 0–1; got ${confidence}`);
  return { id, kind, claim: claimText, evidence, confidence, madeByAgentId, jobId, createdAt: null };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * True when the claim is actionable — VERIFIED, or OBSERVED with evidence.
 * PROPOSED and bare INFERRED claims (no evidence) are not actionable.
 */
export function isActionable(c: EvidenceClaim): boolean {
  if (c.kind === "VERIFIED") return true;
  if (c.kind === "OBSERVED" && c.evidence.length > 0) return true;
  return false;
}

/**
 * INFERRED claims must cite at least one piece of evidence.
 * Returns a validation error string or null when valid.
 */
export function validateClaim(c: EvidenceClaim): string | null {
  if ((c.kind === "INFERRED" || c.kind === "VERIFIED") && c.evidence.length === 0) {
    return `${c.kind} claim "${c.claim}" must cite at least one piece of evidence`;
  }
  if (c.confidence <= 0 && c.kind !== "PROPOSED") {
    return `Non-PROPOSED claim "${c.claim}" must have confidence > 0`;
  }
  return null;
}

/** Filter a list of claims to those of a specific kind. */
export function claimsOfKind(claims: EvidenceClaim[], kind: EvidenceClaimKind): EvidenceClaim[] {
  return claims.filter((c) => c.kind === kind);
}

/** True when any claim in the list is blocking — PROPOSED or unverified INFERRED with low confidence. */
export function hasUnverifiedCritical(claims: EvidenceClaim[]): boolean {
  return claims.some((c) => c.kind === "PROPOSED" && c.confidence < 0.3);
}

// ---------------------------------------------------------------------------
// Upgrade helpers (PROPOSED → OBSERVED → VERIFIED lifecycle)
// ---------------------------------------------------------------------------

/** Mark a claim as VERIFIED (by a human or independent agent). Returns a new claim record. */
export function verifyClaim(c: EvidenceClaim, additionalEvidence: string[] = []): EvidenceClaim {
  return { ...c, kind: "VERIFIED", evidence: [...c.evidence, ...additionalEvidence] };
}

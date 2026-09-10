/**
 * Visual Design Rubric (CTOS-005B Parts 2–4).
 *
 * - Part 2: 18-dimension rubric scoring; verdicts A/B/C; no averaging to hide CRITICAL.
 * - Part 3: Anti-generic design rules — explicit heuristics that challenge hero+3cards etc.
 * - Part 4: Signature visual element governance.
 *
 * All functions are pure; no OSData writes happen here.
 */
import type {
  AntiGenericRule,
  RubricScore,
  VisualDesignRubricResult,
  VisualRubricDimension,
  VisualRubricVerdict,
  ISODate,
} from "@/data/types";
import { VISUAL_RUBRIC_DIMENSIONS } from "@/data/types";

// ---------------------------------------------------------------------------
// Part 2 — Rubric scoring
// ---------------------------------------------------------------------------

/** Score → verdict mapping. 5-4=A, 3=B, 1-2=C. */
export function verdictForScore(score: 1 | 2 | 3 | 4 | 5): VisualRubricVerdict {
  if (score >= 4) return "A";
  if (score === 3) return "B";
  return "C";
}

/**
 * Derive the overall verdict from dimension scores.
 * Rules (in priority order, not by averaging):
 *   1. Any dimension scoring 1 → overall "C" (never averaged away).
 *   2. Any dimension scoring 2 → overall "C".
 *   3. Any dimension scoring 3 → overall "B".
 *   4. All dimensions 4+ → overall "A".
 */
export function deriveOverallVerdict(scores: RubricScore[]): VisualRubricVerdict {
  if (scores.some((s) => s.score <= 2)) return "C";
  if (scores.some((s) => s.score === 3)) return "B";
  return "A";
}

/**
 * Extract critical dimensions (score = 1) — always listed explicitly.
 * These are the dimensions that block launch regardless of overall verdict calculation.
 */
export function extractCriticalDimensions(scores: RubricScore[]): VisualRubricDimension[] {
  return scores.filter((s) => s.score === 1).map((s) => s.dimension);
}

/**
 * Validate that a rubric result covers all 18 required dimensions.
 * Returns any dimensions that are missing from the scores array.
 */
export function missingDimensions(scores: RubricScore[]): VisualRubricDimension[] {
  const scored = new Set(scores.map((s) => s.dimension));
  return VISUAL_RUBRIC_DIMENSIONS.filter((d) => !scored.has(d));
}

/**
 * Assemble a VisualDesignRubricResult from an array of dimension scores.
 * Caller supplies scores; this function derives verdict, critical dimensions, and blocking issues.
 * Does NOT require all 18 dimensions — partial reviews are valid (missing dimensions are noted).
 */
export function assembleRubricResult(
  projectId: string,
  jobId: string | null,
  scores: RubricScore[],
  summary: string,
  assessedAt: ISODate | null = null,
): VisualDesignRubricResult {
  const overallVerdict = deriveOverallVerdict(scores);
  const criticalDimensions = extractCriticalDimensions(scores);
  const missing = missingDimensions(scores);

  const blockingIssues: string[] = [
    ...criticalDimensions.map((d) => `Score 1 on ${d} — launch-blocking defect`),
    ...(missing.length > 0 ? [`Missing dimensions: ${missing.join(", ")}`] : []),
  ];

  return {
    projectId,
    jobId,
    scores,
    overallVerdict,
    criticalDimensions,
    blockingIssues,
    summary,
    assessedAt,
  };
}

// ---------------------------------------------------------------------------
// Part 3 — Anti-generic design rules
// ---------------------------------------------------------------------------

/** The canonical set of anti-generic rules. Each challenges a specific generic pattern. */
export const ANTI_GENERIC_RULES: AntiGenericRule[] = [
  {
    id: "agr_001",
    description: "Avoid the hero-3cards-testimonials layout",
    challengesPattern: "Full-width hero + 3 feature cards + testimonial row",
    preferredApproach: "Lead with the client's primary outcome/application; let the hierarchy reflect the conversion model",
  },
  {
    id: "agr_002",
    description: "Avoid generic icon sets",
    challengesPattern: "Flaticon/generic vector icons with no visual relationship to the brand",
    preferredApproach: "Stylistically consistent icons derived from brand shape language, or remove icons where copy is sufficient",
  },
  {
    id: "agr_003",
    description: "Avoid stock-photo hero images",
    challengesPattern: "Generic handshake/team/office stock photography on the hero",
    preferredApproach: "Application or outcome photography; real product in real context; or intentional abstract if brand calls for it",
  },
  {
    id: "agr_004",
    description: "Avoid gradient-button-on-white CTA",
    challengesPattern: "Rainbow or multi-stop gradient button on a plain white background",
    preferredApproach: "Brand-colour solid or outlined CTA that earns its contrast from the brand palette, not decorative gradients",
  },
  {
    id: "agr_005",
    description: "Avoid the 'why us' section with three icons",
    challengesPattern: "3-column 'Why Choose Us' / 'Our Values' section with generic icons and one-line text",
    preferredApproach: "Evidence-based differentiators with specific claims; or remove if redundant with product/outcome content",
  },
  {
    id: "agr_006",
    description: "Avoid footer-as-menu redundancy",
    challengesPattern: "Footer that simply repeats the main navigation without adding secondary links or contact context",
    preferredApproach: "Footer adds trust signals, contact methods, and secondary paths not in the main nav",
  },
  {
    id: "agr_007",
    description: "Avoid animated counters as social proof",
    challengesPattern: "Animated number counters (e.g. '500+ clients', '10 years') without a source",
    preferredApproach: "Real, evidenced claims with attribution; or remove if unverifiable",
  },
];

/** Look up a rule by id. Returns undefined when not found. */
export function findAntiGenericRule(id: string): AntiGenericRule | undefined {
  return ANTI_GENERIC_RULES.find((r) => r.id === id);
}

/**
 * Check whether a design description triggers any anti-generic rule.
 * Returns the matched rules (by checking for pattern keywords in the description).
 * This is a heuristic signal — not a verdict; a human or agent must confirm.
 */
export function checkAntiGenericPatterns(description: string): AntiGenericRule[] {
  const lower = description.toLowerCase();
  return ANTI_GENERIC_RULES.filter((rule) =>
    rule.challengesPattern
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 4)
      .some((word) => lower.includes(word)),
  );
}

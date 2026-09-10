import { describe, it, expect } from "vitest";
import {
  verdictForScore,
  deriveOverallVerdict,
  extractCriticalDimensions,
  assembleRubricResult,
  ANTI_GENERIC_RULES,
  findAntiGenericRule,
  checkAntiGenericPatterns,
} from "../visual-design-rubric";
import type { RubricScore } from "@/data/types";

// ---------------------------------------------------------------------------
// verdictForScore
// ---------------------------------------------------------------------------
describe("verdictForScore", () => {
  it("scores 4 and 5 map to A", () => {
    expect(verdictForScore(4)).toBe("A");
    expect(verdictForScore(5)).toBe("A");
  });
  it("score 3 maps to B", () => {
    expect(verdictForScore(3)).toBe("B");
  });
  it("scores 1 and 2 map to C", () => {
    expect(verdictForScore(1)).toBe("C");
    expect(verdictForScore(2)).toBe("C");
  });
});

// ---------------------------------------------------------------------------
// deriveOverallVerdict — priority order, no averaging
// ---------------------------------------------------------------------------
describe("deriveOverallVerdict", () => {
  const scoreA = (dim: string): RubricScore => ({
    dimension: dim as any,
    score: 5,
    verdict: "A",
    rationale: "Good",
    evidence: ["screenshot-1"],
  });
  const scoreB = (dim: string): RubricScore => ({
    dimension: dim as any,
    score: 3,
    verdict: "B",
    rationale: "Acceptable",
    evidence: ["screenshot-1"],
  });
  const scoreC = (dim: string): RubricScore => ({
    dimension: dim as any,
    score: 2,
    verdict: "C",
    rationale: "Poor",
    evidence: ["screenshot-1"],
  });

  it("all A scores → overall A", () => {
    expect(deriveOverallVerdict([scoreA("BRAND_ALIGNMENT"), scoreA("TYPOGRAPHY")])).toBe("A");
  });

  it("any B score → overall B even with many A scores", () => {
    expect(deriveOverallVerdict([scoreA("BRAND_ALIGNMENT"), scoreB("TYPOGRAPHY"), scoreA("IMAGERY")])).toBe("B");
  });

  it("any C score → overall C (overrides As and Bs)", () => {
    expect(deriveOverallVerdict([scoreA("BRAND_ALIGNMENT"), scoreB("TYPOGRAPHY"), scoreC("IMAGERY")])).toBe("C");
  });

  it("single score of 1 forces C regardless of other scores", () => {
    const low: RubricScore = { dimension: "POLISH", score: 1, verdict: "C", rationale: "Terrible", evidence: [] };
    const high: RubricScore = { dimension: "BRAND_ALIGNMENT", score: 5, verdict: "A", rationale: "Good", evidence: [] };
    expect(deriveOverallVerdict([high, high, low])).toBe("C");
  });

  it("returns A for empty scores array", () => {
    expect(deriveOverallVerdict([])).toBe("A");
  });
});

// ---------------------------------------------------------------------------
// extractCriticalDimensions — dimensions scoring exactly 1
// ---------------------------------------------------------------------------
describe("extractCriticalDimensions", () => {
  it("returns only dimensions with score === 1 (not score 2)", () => {
    const scores: RubricScore[] = [
      { dimension: "BRAND_ALIGNMENT", score: 5, verdict: "A", rationale: "", evidence: [] },
      { dimension: "TYPOGRAPHY", score: 2, verdict: "C", rationale: "", evidence: [] },
      { dimension: "COLOR_USE", score: 1, verdict: "C", rationale: "", evidence: [] },
    ];
    const critical = extractCriticalDimensions(scores);
    expect(critical).toContain("COLOR_USE");
    expect(critical).not.toContain("BRAND_ALIGNMENT");
    expect(critical).not.toContain("TYPOGRAPHY");
  });

  it("returns empty when all scores are 2+", () => {
    const scores: RubricScore[] = [
      { dimension: "BRAND_ALIGNMENT", score: 2, verdict: "C", rationale: "", evidence: [] },
    ];
    expect(extractCriticalDimensions(scores)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// assembleRubricResult
// ---------------------------------------------------------------------------
describe("assembleRubricResult", () => {
  it("assembles a complete rubric result", () => {
    const scores: RubricScore[] = [
      { dimension: "BRAND_ALIGNMENT", score: 4, verdict: "A", rationale: "On-brand", evidence: ["ss-1440"] },
      { dimension: "TYPOGRAPHY", score: 3, verdict: "B", rationale: "Acceptable", evidence: ["ss-1440"] },
    ];
    const result = assembleRubricResult("proj-1", "job-1", scores, "Overall B verdict — typography needs polish", "2024-01-01T00:00:00Z");
    expect(result.projectId).toBe("proj-1");
    expect(result.jobId).toBe("job-1");
    expect(result.overallVerdict).toBe("B");
    expect(result.summary).toContain("Overall B verdict");
    expect(result.scores).toHaveLength(2);
    expect(result.assessedAt).toBe("2024-01-01T00:00:00Z");
  });

  it("includes missing dimension warnings in blockingIssues", () => {
    const scores: RubricScore[] = [
      { dimension: "BRAND_ALIGNMENT", score: 1, verdict: "C", rationale: "Off-brand", evidence: [] },
    ];
    const result = assembleRubricResult("proj-1", null, scores, "Summary");
    expect(result.blockingIssues.some((b) => b.includes("BRAND_ALIGNMENT"))).toBe(true);
    expect(result.blockingIssues.some((b) => b.includes("Missing"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Anti-generic rules
// ---------------------------------------------------------------------------
describe("ANTI_GENERIC_RULES", () => {
  it("contains 7 rules", () => {
    expect(ANTI_GENERIC_RULES).toHaveLength(7);
  });

  it("all rules have required fields", () => {
    for (const rule of ANTI_GENERIC_RULES) {
      expect(rule.id).toBeTruthy();
      expect(rule.description).toBeTruthy();
      expect(rule.challengesPattern).toBeTruthy();
      expect(rule.preferredApproach).toBeTruthy();
    }
  });

  it("IDs follow agr_00N pattern", () => {
    const ids = ANTI_GENERIC_RULES.map((r) => r.id);
    expect(ids).toContain("agr_001");
    expect(ids).toContain("agr_007");
  });
});

describe("findAntiGenericRule", () => {
  it("finds rule by ID", () => {
    const rule = findAntiGenericRule("agr_001");
    expect(rule).toBeDefined();
    expect(rule!.id).toBe("agr_001");
  });

  it("returns undefined for unknown ID", () => {
    expect(findAntiGenericRule("agr_999")).toBeUndefined();
  });
});

describe("checkAntiGenericPatterns", () => {
  it("returns matching rules for generic patterns", () => {
    const matches = checkAntiGenericPatterns("hero section with 3 cards below and gradient button");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("returns empty for clearly non-generic description", () => {
    const matches = checkAntiGenericPatterns("diagonal grid overlay with overlapping SVG rings");
    expect(matches).toHaveLength(0);
  });
});

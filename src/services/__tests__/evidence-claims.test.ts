import { describe, it, expect } from "vitest";
import {
  claim,
  isActionable,
  validateClaim,
  claimsOfKind,
  hasUnverifiedCritical,
  verifyClaim,
} from "../evidence-claims";

// ---------------------------------------------------------------------------
// claim builder
// ---------------------------------------------------------------------------
describe("claim builder", () => {
  it("creates a valid OBSERVED claim", () => {
    const c = claim("c1", "OBSERVED", "Hero image is a stock photo", ["screenshot-1440-hero"], 0.9);
    expect(c.kind).toBe("OBSERVED");
    expect(c.confidence).toBe(0.9);
    expect(c.evidence).toContain("screenshot-1440-hero");
  });

  it("throws for confidence out of 0–1 range", () => {
    expect(() => claim("c1", "OBSERVED", "Test", [], 1.5)).toThrow(RangeError);
    expect(() => claim("c1", "OBSERVED", "Test", [], -0.1)).toThrow(RangeError);
  });

  it("boundary confidence 0 and 1 are accepted", () => {
    expect(() => claim("c1", "PROPOSED", "Test", [], 0)).not.toThrow();
    expect(() => claim("c1", "VERIFIED", "Test", ["e1"], 1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isActionable
// ---------------------------------------------------------------------------
describe("isActionable", () => {
  it("VERIFIED is actionable", () => {
    const c = claim("c1", "VERIFIED", "Confirmed defect", ["ss-1"], 0.95);
    expect(isActionable(c)).toBe(true);
  });

  it("OBSERVED with evidence is actionable", () => {
    const c = claim("c1", "OBSERVED", "Gradient button visible", ["ss-1440"], 0.9);
    expect(isActionable(c)).toBe(true);
  });

  it("OBSERVED without evidence is not actionable", () => {
    const c = claim("c1", "OBSERVED", "Something seems off", [], 0.5);
    expect(isActionable(c)).toBe(false);
  });

  it("PROPOSED is not actionable", () => {
    const c = claim("c1", "PROPOSED", "Might need fix", [], 0.3);
    expect(isActionable(c)).toBe(false);
  });

  it("INFERRED without evidence is not actionable", () => {
    const c = claim("c1", "INFERRED", "Inferred from pattern", [], 0.6);
    expect(isActionable(c)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateClaim
// ---------------------------------------------------------------------------
describe("validateClaim", () => {
  it("returns null for valid OBSERVED claim with evidence", () => {
    const c = claim("c1", "OBSERVED", "Hero off-brand", ["ss-1440"], 0.9);
    expect(validateClaim(c)).toBeNull();
  });

  it("returns error for INFERRED claim with no evidence", () => {
    const c = claim("c1", "INFERRED", "Something inferred", [], 0.5);
    expect(validateClaim(c)).toContain("evidence");
  });

  it("returns error for VERIFIED claim with no evidence", () => {
    const c = claim("c1", "VERIFIED", "Confirmed", [], 0.9);
    expect(validateClaim(c)).toContain("evidence");
  });

  it("returns null for PROPOSED claim with zero confidence", () => {
    const c = claim("c1", "PROPOSED", "Speculative", [], 0);
    expect(validateClaim(c)).toBeNull();
  });

  it("returns error for non-PROPOSED claim with zero confidence", () => {
    const c = claim("c1", "OBSERVED", "Something", ["ss-1"], 0);
    expect(validateClaim(c)).toContain("confidence");
  });
});

// ---------------------------------------------------------------------------
// claimsOfKind
// ---------------------------------------------------------------------------
describe("claimsOfKind", () => {
  it("filters correctly", () => {
    const claims = [
      claim("c1", "OBSERVED", "Observed", ["e1"], 0.9),
      claim("c2", "INFERRED", "Inferred", ["e1"], 0.7),
      claim("c3", "OBSERVED", "Observed 2", ["e1"], 0.8),
    ];
    expect(claimsOfKind(claims, "OBSERVED")).toHaveLength(2);
    expect(claimsOfKind(claims, "INFERRED")).toHaveLength(1);
    expect(claimsOfKind(claims, "PROPOSED")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// hasUnverifiedCritical
// ---------------------------------------------------------------------------
describe("hasUnverifiedCritical", () => {
  it("returns true when a PROPOSED claim has confidence < 0.3", () => {
    const claims = [claim("c1", "PROPOSED", "Risky claim", [], 0.1)];
    expect(hasUnverifiedCritical(claims)).toBe(true);
  });

  it("returns false when all PROPOSED claims have confidence ≥ 0.3", () => {
    const claims = [claim("c1", "PROPOSED", "Less risky", [], 0.5)];
    expect(hasUnverifiedCritical(claims)).toBe(false);
  });

  it("returns false for empty list", () => {
    expect(hasUnverifiedCritical([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyClaim
// ---------------------------------------------------------------------------
describe("verifyClaim", () => {
  it("upgrades kind to VERIFIED", () => {
    const c = claim("c1", "INFERRED", "Inferred", ["ss-1"], 0.7);
    const verified = verifyClaim(c, ["human-confirmation"]);
    expect(verified.kind).toBe("VERIFIED");
    expect(verified.evidence).toContain("ss-1");
    expect(verified.evidence).toContain("human-confirmation");
  });

  it("works without additional evidence", () => {
    const c = claim("c1", "OBSERVED", "Observed", ["ss-1"], 0.9);
    const verified = verifyClaim(c);
    expect(verified.kind).toBe("VERIFIED");
    expect(verified.evidence).toHaveLength(1);
  });
});

import { describe, it, expect } from "vitest";
import {
  normalizeToCanonical,
  isBlockingSeverity,
  CANONICAL_SEVERITY_ORDER,
  LEGACY_TO_CANONICAL,
  CANONICAL_TO_LEGACY,
} from "../qa-severity";

describe("normalizeToCanonical", () => {
  it("maps P0 to CRITICAL", () => {
    expect(normalizeToCanonical("P0")).toBe("CRITICAL");
  });

  it("maps P1 to MAJOR", () => {
    expect(normalizeToCanonical("P1")).toBe("MAJOR");
  });

  it("maps P2 to MINOR", () => {
    expect(normalizeToCanonical("P2")).toBe("MINOR");
  });

  it("maps P3 to COSMETIC", () => {
    expect(normalizeToCanonical("P3")).toBe("COSMETIC");
  });
});

describe("isBlockingSeverity — legacy P-codes", () => {
  it("P0 is blocking", () => {
    expect(isBlockingSeverity("P0")).toBe(true);
  });

  it("P1 is blocking", () => {
    expect(isBlockingSeverity("P1")).toBe(true);
  });

  it("P2 is not blocking", () => {
    expect(isBlockingSeverity("P2")).toBe(false);
  });

  it("P3 is not blocking", () => {
    expect(isBlockingSeverity("P3")).toBe(false);
  });
});

describe("isBlockingSeverity — canonical names", () => {
  it("CRITICAL is blocking", () => {
    expect(isBlockingSeverity("CRITICAL")).toBe(true);
  });

  it("MAJOR is blocking", () => {
    expect(isBlockingSeverity("MAJOR")).toBe(true);
  });

  it("MINOR is not blocking", () => {
    expect(isBlockingSeverity("MINOR")).toBe(false);
  });

  it("COSMETIC is not blocking", () => {
    expect(isBlockingSeverity("COSMETIC")).toBe(false);
  });
});

describe("CANONICAL_SEVERITY_ORDER", () => {
  it("has four entries most-severe first", () => {
    expect(CANONICAL_SEVERITY_ORDER).toEqual(["CRITICAL", "MAJOR", "MINOR", "COSMETIC"]);
  });
});

describe("LEGACY_TO_CANONICAL", () => {
  it("covers all four P-codes", () => {
    expect(Object.keys(LEGACY_TO_CANONICAL)).toHaveLength(4);
    expect(LEGACY_TO_CANONICAL.P0).toBe("CRITICAL");
    expect(LEGACY_TO_CANONICAL.P3).toBe("COSMETIC");
  });
});

describe("CANONICAL_TO_LEGACY", () => {
  it("round-trips through normalizeToCanonical", () => {
    const p0 = CANONICAL_TO_LEGACY["CRITICAL"];
    expect(normalizeToCanonical(p0)).toBe("CRITICAL");
    const p3 = CANONICAL_TO_LEGACY["COSMETIC"];
    expect(normalizeToCanonical(p3)).toBe("COSMETIC");
  });
});

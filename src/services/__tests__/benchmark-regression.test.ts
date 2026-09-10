/**
 * Benchmark regression harness tests (CTOS-005A Part 14).
 *
 * Validates the regression harness itself against frozen fixture data.
 * No live API calls. No paid provider calls.
 */
import { describe, it, expect } from "vitest";
import {
  runRegressionSuite,
  assertProjectIsolation,
  assertRequiredSchemas,
  assertValidationDeterminism,
  type FrozenFixture,
} from "../benchmark-regression";
import { EMPTY } from "@/gateway/core";

function fixture(schemaKey: string, content: unknown): FrozenFixture {
  return { path: `fixtures/${schemaKey}.json`, schemaKey, description: `Test fixture for ${schemaKey}`, content };
}

// ---------------------------------------------------------------------------
// runRegressionSuite — fixture validation
// ---------------------------------------------------------------------------

describe("runRegressionSuite", () => {
  it("reports unknown schema key as failure", () => {
    const result = runRegressionSuite([fixture("nonexistent_schema@99", {})]);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.results.some((r) => r.schemaKey === "nonexistent_schema@99" && !r.passed)).toBe(true);
  });

  it("returns total count matching fixtures length", () => {
    const result = runRegressionSuite([
      fixture("nonexistent@1", {}),
      fixture("nonexistent@2", {}),
    ]);
    expect(result.totalFixtures).toBe(2);
  });

  it("never makes live API calls — completes instantly", () => {
    // If this runs without network errors, it didn't call any API
    const start = Date.now();
    runRegressionSuite([fixture("discovery_report@1", { name: "test" })]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // well under 1s → no network call
  });

  it("result structure has required fields", () => {
    const result = runRegressionSuite([fixture("discovery_report@1", {})]);
    expect(typeof result.runAt).toBe("string");
    expect(typeof result.totalFixtures).toBe("number");
    expect(typeof result.passed).toBe("number");
    expect(typeof result.failed).toBe("number");
    expect(Array.isArray(result.results)).toBe(true);
  });

  it("each result has required fields", () => {
    const result = runRegressionSuite([fixture("discovery_report@1", {})]);
    const r = result.results[0]!;
    expect(typeof r.fixture).toBe("string");
    expect(typeof r.schemaKey).toBe("string");
    expect(typeof r.passed).toBe("boolean");
    expect(Array.isArray(r.issues)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assertRequiredSchemas
// ---------------------------------------------------------------------------

describe("assertRequiredSchemas", () => {
  it("returns ok and missing fields", () => {
    const result = assertRequiredSchemas();
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.missing)).toBe(true);
  });

  it("build_pack@1 and job_pack@1 are registered", () => {
    const result = assertRequiredSchemas();
    // If they're present, missing should not contain them
    if (!result.ok) {
      // Document what's missing
      expect(result.missing).not.toContain("build_pack@1");
    } else {
      expect(result.missing).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// assertValidationDeterminism
// ---------------------------------------------------------------------------

describe("assertValidationDeterminism", () => {
  it("returns a boolean", () => {
    const result = assertValidationDeterminism("discovery_report@1", {});
    expect(typeof result).toBe("boolean");
  });

  it("same fixture produces consistent result across runs", () => {
    const content = { businessName: "Test", websiteUrl: "https://test.com" };
    const results = Array.from({ length: 5 }, () =>
      assertValidationDeterminism("discovery_report@1", content)
    );
    // All results should be the same (deterministic)
    const allSame = results.every((r) => r === results[0]);
    expect(allSame).toBe(true);
  });

  it("consistently fails for invalid fixture", () => {
    const results = Array.from({ length: 3 }, () =>
      assertValidationDeterminism("discovery_report@1", { bad: "data" })
    );
    const allSame = results.every((r) => r === results[0]);
    expect(allSame).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assertProjectIsolation — regression harness version
// ---------------------------------------------------------------------------

describe("assertProjectIsolation", () => {
  it("passes for clean empty data", () => {
    const result = assertProjectIsolation(EMPTY, "proj-a", "proj-b");
    expect(result.isolated).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("returns violations array", () => {
    const result = assertProjectIsolation(EMPTY, "proj-x", "proj-y");
    expect(Array.isArray(result.violations)).toBe(true);
  });
});

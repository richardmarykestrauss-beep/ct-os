import { describe, it, expect } from "vitest";
import {
  validateScreenshotSet,
  hasRequiredCoverage,
  createVisualComparison,
  hasBlockingFindings,
} from "../screenshot-set";
import type { ExtendedScreenshotEvidence } from "@/data/types";

function shot(viewport: number, status: "captured" | "failed" | "pending" = "captured", capturedAt: string | null = "2024-06-01T00:00:00Z"): ExtendedScreenshotEvidence {
  return {
    id: `ss-${viewport}`,
    projectId: "proj-1",
    jobId: null,
    url: "https://example.com",
    viewport: viewport as any,
    widthPx: viewport,
    heightPx: 900,
    dpr: 1,
    scrollPosition: 0,
    sourceType: "CT_OS_CAPTURE",
    capturedAt,
    captureStatus: status,
    consoleErrors: [],
    loadErrors: [],
  };
}

// ---------------------------------------------------------------------------
// validateScreenshotSet
// ---------------------------------------------------------------------------
describe("validateScreenshotSet — required viewport coverage", () => {
  it("valid when 1440 and 375 are captured", () => {
    const result = validateScreenshotSet([shot(1440), shot(375)]);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("invalid when desktop (1440) is missing", () => {
    const result = validateScreenshotSet([shot(375)]);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.kind === "missing_desktop")).toBe(true);
  });

  it("invalid when mobile (375) is missing", () => {
    const result = validateScreenshotSet([shot(1440)]);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.kind === "missing_mobile")).toBe(true);
  });

  it("empty evidence is invalid (both required viewports missing)", () => {
    const result = validateScreenshotSet([]);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(2);
  });
});

describe("validateScreenshotSet — failed captures", () => {
  it("flags failed captures as issues", () => {
    const result = validateScreenshotSet([shot(1440), shot(375), shot(768, "failed")]);
    expect(result.issues.some((i) => i.kind === "failed_capture" && i.viewport === 768)).toBe(true);
  });
});

describe("validateScreenshotSet — duplicate viewports", () => {
  it("flags duplicate viewport", () => {
    const s1 = shot(1440);
    const s2 = { ...shot(1440), id: "ss-1440-b" };
    const result = validateScreenshotSet([s1, s2, shot(375)]);
    expect(result.issues.some((i) => i.kind === "duplicate_viewport" && i.viewport === 1440)).toBe(true);
  });
});

describe("validateScreenshotSet — stale evidence", () => {
  it("flags screenshot older than 7 days", () => {
    const old = shot(1440, "captured", "2024-01-01T00:00:00Z");
    const result = validateScreenshotSet([old, shot(375)], "2024-02-01T00:00:00Z");
    expect(result.issues.some((i) => i.kind === "stale_evidence" && i.viewport === 1440)).toBe(true);
  });

  it("does not flag recent screenshots", () => {
    const result = validateScreenshotSet([shot(1440, "captured", "2024-06-01T00:00:00Z"), shot(375)], "2024-06-03T00:00:00Z");
    expect(result.issues.some((i) => i.kind === "stale_evidence")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasRequiredCoverage
// ---------------------------------------------------------------------------
describe("hasRequiredCoverage", () => {
  it("true when 1440 and 375 are present", () => {
    expect(hasRequiredCoverage([shot(1440), shot(375)])).toBe(true);
  });

  it("false when either required viewport is missing", () => {
    expect(hasRequiredCoverage([shot(1440)])).toBe(false);
    expect(hasRequiredCoverage([shot(375)])).toBe(false);
    expect(hasRequiredCoverage([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createVisualComparison
// ---------------------------------------------------------------------------
describe("createVisualComparison", () => {
  it("creates comparison record with given kind and findings", () => {
    const findings = [{ kind: "geometry_diff" as const, description: "Hero layout differs", severity: "P1" as any }];
    const cmp = createVisualComparison("cmp-1", "proj-1", null, "CURRENT_VS_REFERENCE", findings, "Minor geometry delta");
    expect(cmp.projectId).toBe("proj-1");
    expect(cmp.kind).toBe("CURRENT_VS_REFERENCE");
    expect(cmp.findings).toHaveLength(1);
    expect(cmp.summary).toContain("Minor geometry delta");
  });
});

// ---------------------------------------------------------------------------
// hasBlockingFindings
// ---------------------------------------------------------------------------
describe("hasBlockingFindings", () => {
  it("returns true when P0 finding exists", () => {
    const cmp = createVisualComparison("cmp-1", "proj-1", null, "BUILD_VS_COMPOSITION", [
      { kind: "layout_broken", description: "Critical layout break", severity: "P0" as any },
    ], "");
    expect(hasBlockingFindings(cmp)).toBe(true);
  });

  it("returns false when only P2/P3 findings", () => {
    const cmp = createVisualComparison("cmp-1", "proj-1", null, "DESKTOP_VS_MOBILE", [
      { kind: "color_inconsistency", description: "Minor color shift", severity: "P2" as any },
    ], "");
    expect(hasBlockingFindings(cmp)).toBe(false);
  });

  it("returns false for empty findings", () => {
    const cmp = createVisualComparison("cmp-1", "proj-1", null, "BEFORE_VS_AFTER", [], "");
    expect(hasBlockingFindings(cmp)).toBe(false);
  });
});

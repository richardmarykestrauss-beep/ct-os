import { describe, it, expect } from "vitest";
import {
  isBlockingDefect,
  isStructuralDefect,
  createVisualDefect,
  resolveVisualDefect,
  openBlockingDefects,
  visualDefectCounts,
} from "../visual-defects";
import type { OSData, VisualDefect } from "@/data/types";
import { EMPTY } from "@/gateway/core";

const baseData = (): OSData => ({ ...EMPTY });

function defect(overrides: Partial<VisualDefect> = {}): VisualDefect {
  return {
    id: "vdef-1",
    projectId: "proj-1",
    jobId: null,
    category: "LAYOUT",
    severity: "P0",
    description: "Layout break in hero",
    evidence: [],
    status: "OPEN",
    detectedByAgentId: null,
    createdAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isBlockingDefect
// ---------------------------------------------------------------------------
describe("isBlockingDefect", () => {
  it("P0 is blocking", () => {
    expect(isBlockingDefect(defect({ severity: "P0" }))).toBe(true);
  });
  it("P1 is blocking", () => {
    expect(isBlockingDefect(defect({ severity: "P1" }))).toBe(true);
  });
  it("P2 is not blocking", () => {
    expect(isBlockingDefect(defect({ severity: "P2" }))).toBe(false);
  });
  it("P3 is not blocking", () => {
    expect(isBlockingDefect(defect({ severity: "P3" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isStructuralDefect
// ---------------------------------------------------------------------------
describe("isStructuralDefect", () => {
  it("LAYOUT is structural", () => {
    expect(isStructuralDefect(defect({ category: "LAYOUT" }))).toBe(true);
  });
  it("OVERFLOW is structural", () => {
    expect(isStructuralDefect(defect({ category: "OVERFLOW" }))).toBe(true);
  });
  it("TYPOGRAPHY is not structural", () => {
    expect(isStructuralDefect(defect({ category: "TYPOGRAPHY" }))).toBe(false);
  });
  it("COLOR is not structural", () => {
    expect(isStructuralDefect(defect({ category: "COLOR" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createVisualDefect
// ---------------------------------------------------------------------------
describe("createVisualDefect", () => {
  it("adds defect to OSData", () => {
    const { data, defect: d } = createVisualDefect(baseData(), {
      projectId: "proj-1",
      category: "LAYOUT",
      severity: "P0",
      description: "Hero layout broken at 375px",
      evidence: ["screenshot-375"],
      id: "vdef-test",
    });
    expect(data.visualDefects).toHaveLength(1);
    expect(d.status).toBe("OPEN");
    expect(d.evidence).toContain("screenshot-375");
    expect(d.resolvedAt).toBeNull();
  });

  it("sets viewport when provided", () => {
    const { defect: d } = createVisualDefect(baseData(), {
      projectId: "proj-1", category: "RESPONSIVE", severity: "P1",
      description: "Overflow at 375", viewport: 375,
    });
    expect(d.viewport).toBe(375);
  });
});

// ---------------------------------------------------------------------------
// resolveVisualDefect
// ---------------------------------------------------------------------------
describe("resolveVisualDefect", () => {
  it("marks defect as VERIFIED", () => {
    const { data: withDefect } = createVisualDefect(baseData(), {
      projectId: "proj-1", category: "LAYOUT", severity: "P0",
      description: "Layout break", id: "vdef-r1",
    });
    const { data: resolved, defect: d } = resolveVisualDefect(withDefect, "vdef-r1", "VERIFIED", "2024-06-01T00:00:00Z");
    expect(d.status).toBe("VERIFIED");
    expect(d.resolvedAt).toBe("2024-06-01T00:00:00Z");
    expect(resolved.visualDefects[0]!.status).toBe("VERIFIED");
  });

  it("throws for unknown defect ID", () => {
    expect(() => resolveVisualDefect(baseData(), "nonexistent", "FIXED")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// openBlockingDefects
// ---------------------------------------------------------------------------
describe("openBlockingDefects", () => {
  it("returns P0 and P1 OPEN defects", () => {
    let data = baseData();
    ({ data } = createVisualDefect(data, { projectId: "proj-1", category: "LAYOUT", severity: "P0", description: "P0", id: "d1" }));
    ({ data } = createVisualDefect(data, { projectId: "proj-1", category: "COLOR", severity: "P1", description: "P1", id: "d2" }));
    ({ data } = createVisualDefect(data, { projectId: "proj-1", category: "SPACING", severity: "P2", description: "P2", id: "d3" }));
    const blocking = openBlockingDefects(data, "proj-1");
    expect(blocking).toHaveLength(2);
    expect(blocking.map((d) => d.id)).toContain("d1");
    expect(blocking.map((d) => d.id)).toContain("d2");
  });

  it("excludes resolved defects", () => {
    let data = baseData();
    ({ data } = createVisualDefect(data, { projectId: "proj-1", category: "LAYOUT", severity: "P0", description: "P0", id: "d1" }));
    ({ data } = resolveVisualDefect(data, "d1", "VERIFIED"));
    expect(openBlockingDefects(data, "proj-1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// visualDefectCounts
// ---------------------------------------------------------------------------
describe("visualDefectCounts", () => {
  it("returns zero counts for empty data", () => {
    const counts = visualDefectCounts(baseData(), "proj-1");
    expect(counts).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0 });
  });

  it("correctly counts by severity", () => {
    let data = baseData();
    ({ data } = createVisualDefect(data, { projectId: "proj-1", category: "LAYOUT", severity: "P0", description: "", id: "d1" }));
    ({ data } = createVisualDefect(data, { projectId: "proj-1", category: "LAYOUT", severity: "P0", description: "", id: "d2" }));
    ({ data } = createVisualDefect(data, { projectId: "proj-1", category: "TYPOGRAPHY", severity: "P2", description: "", id: "d3" }));
    const counts = visualDefectCounts(data, "proj-1");
    expect(counts.P0).toBe(2);
    expect(counts.P2).toBe(1);
    expect(counts.P1).toBe(0);
  });
});

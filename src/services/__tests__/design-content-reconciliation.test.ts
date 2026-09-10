import { describe, it, expect } from "vitest";
import {
  createReconciliation,
  resolveReconciliation,
  openReconciliations,
  allReconciled,
  needsHumanReconciliations,
} from "../design-content-reconciliation";
import type { OSData } from "@/data/types";
import { EMPTY } from "@/gateway/core";

const baseData = (): OSData => ({ ...EMPTY });

// ---------------------------------------------------------------------------
// createReconciliation
// ---------------------------------------------------------------------------
describe("createReconciliation", () => {
  it("creates an OPEN reconciliation", () => {
    const { data, reconciliation } = createReconciliation(baseData(), {
      projectId: "proj-1",
      description: "Hero copy and design direction conflict on headline length",
      id: "dcr-1",
    });
    expect(data.designContentReconciliations).toHaveLength(1);
    expect(reconciliation.status).toBe("OPEN");
    expect(reconciliation.resolvedBy).toBeNull();
  });

  it("supports optional artifact IDs", () => {
    const { reconciliation } = createReconciliation(baseData(), {
      projectId: "proj-1",
      description: "Conflict",
      designArtifactId: "art-design-1",
      contentArtifactId: "art-content-1",
    });
    expect(reconciliation.designArtifactId).toBe("art-design-1");
    expect(reconciliation.contentArtifactId).toBe("art-content-1");
  });
});

// ---------------------------------------------------------------------------
// resolveReconciliation
// ---------------------------------------------------------------------------
describe("resolveReconciliation", () => {
  it("resolves with RESOLVED_BY_CONTENT", () => {
    const { data: d1 } = createReconciliation(baseData(), { projectId: "proj-1", description: "Conflict", id: "dcr-1" });
    const { data: d2, reconciliation } = resolveReconciliation(d1, "dcr-1", "RESOLVED_BY_CONTENT", "Richard", "2024-06-01T00:00:00Z");
    expect(reconciliation.status).toBe("RESOLVED_BY_CONTENT");
    expect(reconciliation.resolvedBy).toBe("Richard");
    expect(d2.designContentReconciliations[0]!.status).toBe("RESOLVED_BY_CONTENT");
  });

  it("resolves with RESOLVED_BY_DESIGN", () => {
    const { data: d1 } = createReconciliation(baseData(), { projectId: "proj-1", description: "Conflict", id: "dcr-1" });
    const { reconciliation } = resolveReconciliation(d1, "dcr-1", "RESOLVED_BY_DESIGN", "A03");
    expect(reconciliation.status).toBe("RESOLVED_BY_DESIGN");
  });

  it("resolves with NEEDS_HUMAN", () => {
    const { data: d1 } = createReconciliation(baseData(), { projectId: "proj-1", description: "Conflict", id: "dcr-1" });
    const { reconciliation } = resolveReconciliation(d1, "dcr-1", "NEEDS_HUMAN", "ORCH");
    expect(reconciliation.status).toBe("NEEDS_HUMAN");
  });

  it("throws when reconciliation not found", () => {
    expect(() => resolveReconciliation(baseData(), "nonexistent", "RESOLVED_BY_CONTENT", "Richard")).toThrow();
  });

  it("throws when already resolved", () => {
    const { data: d1 } = createReconciliation(baseData(), { projectId: "proj-1", description: "Conflict", id: "dcr-1" });
    const { data: d2 } = resolveReconciliation(d1, "dcr-1", "RESOLVED_BY_CONTENT", "Richard");
    expect(() => resolveReconciliation(d2, "dcr-1", "RESOLVED_BY_DESIGN", "Richard")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// openReconciliations
// ---------------------------------------------------------------------------
describe("openReconciliations", () => {
  it("returns OPEN reconciliations for the project", () => {
    let data = baseData();
    ({ data } = createReconciliation(data, { projectId: "proj-1", description: "A", id: "dcr-1" }));
    ({ data } = createReconciliation(data, { projectId: "proj-1", description: "B", id: "dcr-2" }));
    ({ data } = resolveReconciliation(data, "dcr-1", "RESOLVED_BY_CONTENT", "Richard"));
    const open = openReconciliations(data, "proj-1");
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe("dcr-2");
  });

  it("does not include other projects' reconciliations", () => {
    let data = baseData();
    ({ data } = createReconciliation(data, { projectId: "proj-other", description: "X", id: "dcr-x" }));
    expect(openReconciliations(data, "proj-1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// allReconciled
// ---------------------------------------------------------------------------
describe("allReconciled", () => {
  it("returns true when no reconciliations exist", () => {
    expect(allReconciled(baseData(), "proj-1")).toBe(true);
  });

  it("returns false when any reconciliation is OPEN", () => {
    const { data } = createReconciliation(baseData(), { projectId: "proj-1", description: "X", id: "dcr-1" });
    expect(allReconciled(data, "proj-1")).toBe(false);
  });

  it("returns true after all reconciliations are resolved", () => {
    let data = baseData();
    ({ data } = createReconciliation(data, { projectId: "proj-1", description: "X", id: "dcr-1" }));
    ({ data } = resolveReconciliation(data, "dcr-1", "RESOLVED_BY_CONTENT", "Richard"));
    expect(allReconciled(data, "proj-1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// needsHumanReconciliations
// ---------------------------------------------------------------------------
describe("needsHumanReconciliations", () => {
  it("returns reconciliations requiring human input", () => {
    let data = baseData();
    ({ data } = createReconciliation(data, { projectId: "proj-1", description: "X", id: "dcr-1" }));
    ({ data } = resolveReconciliation(data, "dcr-1", "NEEDS_HUMAN", "ORCH"));
    expect(needsHumanReconciliations(data, "proj-1")).toHaveLength(1);
  });

  it("does not return OPEN or other resolved statuses", () => {
    let data = baseData();
    ({ data } = createReconciliation(data, { projectId: "proj-1", description: "Open", id: "dcr-open" }));
    expect(needsHumanReconciliations(data, "proj-1")).toHaveLength(0);
  });
});

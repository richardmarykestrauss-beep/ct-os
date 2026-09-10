import { describe, it, expect } from "vitest";
import { checkDesignGate, postBuildVisualStage, postBuildVisualStageAction } from "../design-gates";
import type { Artifact, BuildPack, OSData } from "@/data/types";
import { EMPTY } from "@/gateway/core";

const baseData = (): OSData => ({ ...EMPTY });

function finalArtifact(type: Artifact["type"], projectId = "proj-1", createdByAgentId = "agent_03"): Artifact {
  return {
    id: `art-${type}`,
    projectId,
    type,
    title: type,
    version: 1,
    status: "FINAL",
    schemaVersion: 1,
    storageLocation: null,
    supersedesArtifactId: null,
    createdByAgentId,
    createdByProvider: null,
    createdAt: null,
    updatedAt: null,
  };
}

function readyBuildPack(projectId = "proj-1"): BuildPack {
  return {
    id: "bp-1",
    projectId,
    version: 1,
    status: "READY",
    siteBlueprintArtifactId: null,
    designSystemArtifactId: null,
    contentPackArtifactId: null,
    pages: [],
    constraints: [],
    permissions: [],
    acceptanceCriteria: [],
    evidenceRequirements: [],
    conflicts: [],
    assembledByJobId: null,
    assembledAt: null,
    supersededById: null,
    createdAt: null,
  };
}

// ---------------------------------------------------------------------------
// checkDesignGate — BLOCKED cases
// ---------------------------------------------------------------------------
describe("checkDesignGate — BLOCKED cases", () => {
  it("blocked when no artifacts exist", () => {
    const result = checkDesignGate(baseData(), "proj-1");
    expect(result.status).toBe("BLOCKED");
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("blocked when site_blueprint is missing", () => {
    const data: OSData = {
      ...baseData(),
      artifacts: [
        finalArtifact("design_direction"),
        finalArtifact("page_composition"),
        finalArtifact("content_pack"),
      ],
      buildPacks: [readyBuildPack()],
    };
    const result = checkDesignGate(data, "proj-1");
    expect(result.status).toBe("BLOCKED");
    expect(result.blockers.some((b) => b.includes("site_blueprint"))).toBe(true);
  });

  it("blocked when open reconciliations exist", () => {
    const data: OSData = {
      ...baseData(),
      artifacts: [
        finalArtifact("site_blueprint"),
        finalArtifact("design_direction"),
        finalArtifact("page_composition"),
        finalArtifact("content_pack"),
      ],
      buildPacks: [readyBuildPack()],
      designContentReconciliations: [
        { id: "dcr-1", projectId: "proj-1", description: "Conflict", status: "OPEN", designArtifactId: null, contentArtifactId: null, resolvedBy: null, resolvedAt: null, createdAt: null },
      ],
    };
    const result = checkDesignGate(data, "proj-1");
    expect(result.status).toBe("BLOCKED");
    expect(result.blockers.some((b) => b.includes("reconciliation"))).toBe(true);
  });

  it("blocked when no READY build pack", () => {
    const data: OSData = {
      ...baseData(),
      artifacts: [
        finalArtifact("site_blueprint"),
        finalArtifact("design_direction"),
        finalArtifact("page_composition"),
        finalArtifact("content_pack"),
      ],
    };
    const result = checkDesignGate(data, "proj-1");
    expect(result.status).toBe("BLOCKED");
    expect(result.blockers.some((b) => b.includes("build pack"))).toBe(true);
  });
});

describe("checkDesignGate — PASS", () => {
  it("passes when all required artifacts are FINAL, no open recs, and build pack is READY", () => {
    const data: OSData = {
      ...baseData(),
      artifacts: [
        finalArtifact("site_blueprint"),
        finalArtifact("design_direction"),
        finalArtifact("page_composition"),
        finalArtifact("content_pack"),
      ],
      buildPacks: [readyBuildPack()],
    };
    const result = checkDesignGate(data, "proj-1");
    expect(result.status).toBe("PASS");
    expect(result.blockers).toHaveLength(0);
    expect(result.passed.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// postBuildVisualStage
// ---------------------------------------------------------------------------
describe("postBuildVisualStage", () => {
  it("returns BUILD when no build artifact exists", () => {
    expect(postBuildVisualStage(baseData(), "proj-1")).toBe("BUILD");
  });

  it("returns SCREENSHOT_CAPTURE after build_report is FINAL", () => {
    const data: OSData = {
      ...baseData(),
      artifacts: [finalArtifact("build_report")],
    };
    expect(postBuildVisualStage(data, "proj-1")).toBe("SCREENSHOT_CAPTURE");
  });

  it("returns A03_VISUAL_REVIEW after screenshots captured", () => {
    const data: OSData = {
      ...baseData(),
      artifacts: [finalArtifact("build_report")],
      screenshotEvidence: [{
        id: "ss-1", projectId: "proj-1", jobId: null, url: "https://example.com",
        viewport: "desktop", widthPx: 1440, heightPx: 900,
        capturedAt: null, captureStatus: "captured",
        consoleErrors: [], loadErrors: [],
      }],
    };
    expect(postBuildVisualStage(data, "proj-1")).toBe("A03_VISUAL_REVIEW");
  });

  it("returns A06_QA after A03 visual review", () => {
    const data: OSData = {
      ...baseData(),
      artifacts: [
        finalArtifact("build_report"),
        { ...finalArtifact("visual_review", "proj-1", "agent_03"), id: "art-vr-a03" },
      ],
    };
    expect(postBuildVisualStage(data, "proj-1")).toBe("A06_QA");
  });

  it("returns HUMAN_APPROVAL after A06 visual review", () => {
    const data: OSData = {
      ...baseData(),
      artifacts: [
        finalArtifact("build_report"),
        { ...finalArtifact("visual_review", "proj-1", "agent_06"), id: "art-vr-a06" },
      ],
    };
    expect(postBuildVisualStage(data, "proj-1")).toBe("HUMAN_APPROVAL");
  });

  it("returns APPROVED when STAGING_BUILD approval exists", () => {
    const data: OSData = {
      ...baseData(),
      approvals: [{
        id: "appr-1", projectId: "proj-1", gate: "STAGING_BUILD", status: "APPROVED",
        requestedBy: "Richard", decidedBy: "Richard", decidedById: "u_richard",
        decidedAt: null, createdAt: null,
      }],
    };
    expect(postBuildVisualStage(data, "proj-1")).toBe("APPROVED");
  });
});

// ---------------------------------------------------------------------------
// postBuildVisualStageAction
// ---------------------------------------------------------------------------
describe("postBuildVisualStageAction", () => {
  it("returns a non-empty action string for every stage", () => {
    const stages = ["BUILD", "SCREENSHOT_CAPTURE", "A03_VISUAL_REVIEW", "A06_QA", "HUMAN_APPROVAL", "APPROVED"] as const;
    for (const stage of stages) {
      const action = postBuildVisualStageAction(stage);
      expect(action).toBeTruthy();
      expect(typeof action).toBe("string");
    }
  });
});

/**
 * Project isolation tests (CTOS-005A Part 13).
 *
 * Proves that:
 * - Cross-project artifact references in build packs are caught
 * - DOCTRINE knowledge has no projectId restriction (shared globally)
 * - PROJECT-scoped knowledge is restricted to its project
 * - Jobs are isolated by projectId
 */
import { describe, it, expect } from "vitest";
import type { OSData } from "@/data/types";
import { EMPTY } from "@/gateway/core";
import { buildPackIsolationCheck } from "../build-pack";
import { assertProjectIsolation } from "../benchmark-regression";

function makeArtifact(id: string, projectId: string, type: string, status = "FINAL") {
  return {
    id, projectId, type: type as any, title: type,
    status: status as any, version: 1,
    createdByAgentId: null, createdByProvider: null,
    jobId: null, ticketId: null, content: {},
    storageLocation: null, schemaVersion: null, supersedesArtifactId: null,
    createdAt: null, updatedAt: null,
  } as any;
}

function makeKnowledge(id: string, projectId: string | null | undefined, scope: string) {
  return {
    id, scope: scope as any,
    projectId: projectId ?? undefined,
    category: "PROCESS" as any,
    title: "Test knowledge",
    content: "test knowledge",
    tags: [],
    confidence: 0.9,
    status: "APPROVED" as any,
    jobId: "job-1",
    evidence: [],
    proposedByAgentId: null,
    reviewedById: null, reviewedAt: null, reviewedBy: null,
    createdAt: null, updatedAt: null,
  } as any;
}

function makeBuildPack(id: string, projectId: string, artifactIds: {
  siteBlueprintArtifactId?: string | null;
  designSystemArtifactId?: string | null;
  contentPackArtifactId?: string | null;
}) {
  return {
    id, projectId, version: 1, status: "READY" as const,
    siteBlueprintArtifactId: artifactIds.siteBlueprintArtifactId ?? null,
    designSystemArtifactId: artifactIds.designSystemArtifactId ?? null,
    contentPackArtifactId: artifactIds.contentPackArtifactId ?? null,
    pages: [], constraints: [], permissions: [], acceptanceCriteria: [],
    evidenceRequirements: [], conflicts: [],
    assembledByJobId: null, assembledAt: null, supersededById: null, createdAt: null,
  };
}

// ---------------------------------------------------------------------------
// buildPackIsolationCheck — cross-project artifact rejection
// ---------------------------------------------------------------------------

describe("buildPackIsolationCheck", () => {
  it("returns conflict when build pack references artifact from another project", () => {
    const data: OSData = {
      ...EMPTY,
      artifacts: [
        makeArtifact("bp-from-proj-b", "proj-b", "site_blueprint"),
      ],
    };
    const pack = makeBuildPack("pack-a", "proj-a", { siteBlueprintArtifactId: "bp-from-proj-b" });
    const conflicts = buildPackIsolationCheck(data, pack);
    expect(conflicts.some((c) => c.kind === "cross_project_artifact")).toBe(true);
  });

  it("returns no conflicts when all artifacts belong to same project", () => {
    const data: OSData = {
      ...EMPTY,
      artifacts: [
        makeArtifact("bp-1", "proj-a", "site_blueprint"),
        makeArtifact("ds-1", "proj-a", "design_system"),
      ],
    };
    const pack = makeBuildPack("pack-a", "proj-a", {
      siteBlueprintArtifactId: "bp-1",
      designSystemArtifactId: "ds-1",
    });
    const conflicts = buildPackIsolationCheck(data, pack);
    expect(conflicts.filter((c) => c.kind === "cross_project_artifact")).toHaveLength(0);
  });

  it("returns no conflicts when artifact IDs are null", () => {
    const data: OSData = { ...EMPTY };
    const pack = makeBuildPack("pack-a", "proj-a", {});
    const conflicts = buildPackIsolationCheck(data, pack);
    expect(conflicts.filter((c) => c.kind === "cross_project_artifact")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// assertProjectIsolation (benchmark-regression harness)
// ---------------------------------------------------------------------------

describe("assertProjectIsolation", () => {
  it("passes when two projects share no artifacts", () => {
    const data: OSData = {
      ...EMPTY,
      artifacts: [
        makeArtifact("a-1", "proj-a", "site_blueprint"),
        makeArtifact("b-1", "proj-b", "site_blueprint"),
      ],
    };
    const result = assertProjectIsolation(data, "proj-a", "proj-b");
    expect(result.isolated).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("reports violation when build pack references artifact from wrong project", () => {
    const data: OSData = {
      ...EMPTY,
      artifacts: [makeArtifact("shared-art", "proj-a", "design_system")],
      buildPacks: [makeBuildPack("bp-b", "proj-b", { designSystemArtifactId: "shared-art" })],
    };
    const result = assertProjectIsolation(data, "proj-a", "proj-b");
    expect(result.isolated).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("passes for clean empty data", () => {
    const result = assertProjectIsolation(EMPTY, "proj-a", "proj-b");
    expect(result.isolated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Knowledge scope isolation
// ---------------------------------------------------------------------------

describe("knowledge scope isolation", () => {
  it("DOCTRINE knowledge has no projectId (shared globally)", () => {
    const data: OSData = {
      ...EMPTY,
      knowledgeItems: [makeKnowledge("k1", null, "DOCTRINE")],
    };
    const doctrineItems = data.knowledgeItems.filter((k) => k.scope === "DOCTRINE");
    expect(doctrineItems).toHaveLength(1);
    expect(doctrineItems[0]!.projectId).toBeUndefined();
  });

  it("PROJECT knowledge is scoped to its project", () => {
    const data: OSData = {
      ...EMPTY,
      knowledgeItems: [
        makeKnowledge("k2", "proj-a", "PROJECT"),
        makeKnowledge("k3", "proj-b", "PROJECT"),
      ],
    };
    const projA = data.knowledgeItems.filter((k) => k.scope === "PROJECT" && k.projectId === "proj-a");
    const projB = data.knowledgeItems.filter((k) => k.scope === "PROJECT" && k.projectId === "proj-b");
    expect(projA).toHaveLength(1);
    expect(projB).toHaveLength(1);
    expect(projA[0]!.id).not.toBe(projB[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// Job isolation
// ---------------------------------------------------------------------------

describe("job isolation", () => {
  it("agentJobs are isolated by projectId", () => {
    const makeJob = (id: string, projectId: string) => ({
      id, projectId, agentId: "a1",
      taskType: "SITE_DISCOVERY" as any, instructions: "",
      inputArtifactIds: [], availableToolIds: [],
      requiredOutputSchema: "discovery_report@1", requiredCapabilities: [],
      preferredProvider: "claude" as const, fallbackProviders: [],
      permissionLevel: "GREEN" as const, status: "QUEUED" as const,
      outputArtifactId: null, handoffId: null, requestedById: null,
      createdAt: null, updatedAt: null, startedAt: null, completedAt: null,
    });
    const data: OSData = {
      ...EMPTY,
      agentJobs: [makeJob("job-a", "proj-a"), makeJob("job-b", "proj-b")],
    };
    expect(data.agentJobs.filter((j) => j.projectId === "proj-a")).toHaveLength(1);
    expect(data.agentJobs.filter((j) => j.projectId === "proj-b")).toHaveLength(1);
    expect(data.agentJobs[0]!.id).not.toBe(data.agentJobs[1]!.id);
  });
});

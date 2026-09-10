import { describe, it, expect } from "vitest";
import { deriveAttentionQueue, projectAttentionQueue, projectClear } from "../attention-queue";
import type { OSData } from "@/data/types";
import { EMPTY } from "@/gateway/core";

const baseData = (): OSData => ({ ...EMPTY });

describe("deriveAttentionQueue — empty data", () => {
  it("returns empty queue for empty OSData", () => {
    expect(deriveAttentionQueue(baseData())).toHaveLength(0);
  });
});

describe("deriveAttentionQueue — NEEDS_A_HAND jobs", () => {
  it("adds CRITICAL item for NEEDS_A_HAND job", () => {
    const data: OSData = {
      ...baseData(),
      agentJobs: [{
        id: "job-1", projectId: "proj-a", agentId: "a1",
        taskType: "SITE_DISCOVERY" as any, instructions: "",
        inputArtifactIds: [], availableToolIds: [],
        requiredOutputSchema: "discovery_report@1", requiredCapabilities: [],
        preferredProvider: "claude", fallbackProviders: [],
        permissionLevel: "GREEN", status: "NEEDS_A_HAND",
        outputArtifactId: null, handoffId: null, requestedById: null,
        error: "All providers exhausted",
        createdAt: null, updatedAt: null, startedAt: null, completedAt: null,
      }],
    };
    const queue = deriveAttentionQueue(data);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.kind).toBe("needs_a_hand");
    expect(queue[0]!.urgency).toBe("CRITICAL");
    expect(queue[0]!.detail).toContain("All providers exhausted");
  });

  it("NEEDS_A_HAND without error message uses generic detail", () => {
    const data: OSData = {
      ...baseData(),
      agentJobs: [{
        id: "job-2", projectId: "proj-a", agentId: "a1",
        taskType: "SITE_DISCOVERY" as any, instructions: "",
        inputArtifactIds: [], availableToolIds: [],
        requiredOutputSchema: "discovery_report@1", requiredCapabilities: [],
        preferredProvider: "claude", fallbackProviders: [],
        permissionLevel: "GREEN", status: "NEEDS_A_HAND",
        outputArtifactId: null, handoffId: null, requestedById: null,
        createdAt: null, updatedAt: null, startedAt: null, completedAt: null,
      }],
    };
    const queue = deriveAttentionQueue(data);
    expect(queue[0]!.detail).toContain("Mode B");
  });
});

describe("deriveAttentionQueue — pending approvals", () => {
  it("adds HIGH item for pending job approval", () => {
    const data: OSData = {
      ...baseData(),
      jobApprovals: [{
        id: "appr-1", jobId: "job-1", projectId: "proj-a",
        agentId: "a1", kind: "APPROVAL" as const, permissionLevel: "AMBER" as const,
        actionFingerprint: "fp1", requestedAction: "write file",
        requestedById: "u1", requestedByName: "User",
        approvedById: null, approvedByName: null, approvedByRole: null,
        status: "PENDING" as const, createdAt: null, decidedAt: null,
        consumedAt: null, expiresAt: null,
      }],
    };
    const queue = deriveAttentionQueue(data);
    const item = queue.find((i) => i.kind === "pending_approval");
    expect(item).toBeDefined();
    expect(item!.urgency).toBe("HIGH");
    expect(item!.projectId).toBe("proj-a");
  });
});

describe("deriveAttentionQueue — launch holds", () => {
  it("adds HIGH item for unresolved launch hold", () => {
    const data: OSData = {
      ...baseData(),
      launchHolds: [{
        id: "hold-1", projectId: "proj-a",
        title: "Client not signed off",
        owner: "Client" as const, resolved: false,
        resolvedAt: null, createdAt: null,
      }],
    };
    const queue = deriveAttentionQueue(data);
    const item = queue.find((i) => i.kind === "launch_hold");
    expect(item).toBeDefined();
    expect(item!.urgency).toBe("HIGH");
  });

  it("does NOT add item for resolved launch hold", () => {
    const data: OSData = {
      ...baseData(),
      launchHolds: [{
        id: "hold-2", projectId: "proj-a",
        title: "Resolved hold",
        owner: "Creative Touch" as const, resolved: true,
        resolvedAt: "2025-01-01T00:00:00Z", createdAt: null,
      }],
    };
    const queue = deriveAttentionQueue(data);
    expect(queue.find((i) => i.kind === "launch_hold")).toBeUndefined();
  });
});

describe("deriveAttentionQueue — QA items", () => {
  it("adds HIGH item for P0 QA defect", () => {
    const data: OSData = {
      ...baseData(),
      qaItems: [{
        id: "qa-1", projectId: "proj-a",
        title: "Site crashes on mobile", severity: "P0" as const,
        category: "PERFORMANCE" as any, description: "Infinite loop in hydration",
        status: "OPEN" as const, createdAt: null, resolvedAt: null,
      }],
    };
    const queue = deriveAttentionQueue(data);
    const item = queue.find((i) => i.kind === "qa_critical");
    expect(item).toBeDefined();
    expect(item!.urgency).toBe("HIGH");
  });

  it("adds MEDIUM item for P1 QA defect", () => {
    const data: OSData = {
      ...baseData(),
      qaItems: [{
        id: "qa-2", projectId: "proj-a",
        title: "Form validation missing", severity: "P1" as const,
        category: "FUNCTIONALITY" as any, description: "Contact form has no validation",
        status: "OPEN" as const, createdAt: null, resolvedAt: null,
      }],
    };
    const queue = deriveAttentionQueue(data);
    expect(queue.find((i) => i.kind === "qa_major")?.urgency).toBe("MEDIUM");
  });

  it("does NOT add item for VERIFIED P0", () => {
    const data: OSData = {
      ...baseData(),
      qaItems: [{
        id: "qa-3", projectId: "proj-a",
        title: "Fixed crash", severity: "P0" as const,
        category: "PERFORMANCE" as any, description: "Fixed",
        status: "VERIFIED" as const, createdAt: null, resolvedAt: "2025-01-01T00:00:00Z",
      }],
    };
    expect(deriveAttentionQueue(data).find((i) => i.kind === "qa_critical")).toBeUndefined();
  });

  it("does NOT add item for WONT_FIX P1", () => {
    const data: OSData = {
      ...baseData(),
      qaItems: [{
        id: "qa-4", projectId: "proj-a",
        title: "Known issue", severity: "P1" as const,
        category: "DESIGN" as any, description: "Won't fix",
        status: "WONT_FIX" as const, createdAt: null, resolvedAt: null,
      }],
    };
    expect(deriveAttentionQueue(data).find((i) => i.kind === "qa_major")).toBeUndefined();
  });
});

describe("deriveAttentionQueue — build pack conflicts", () => {
  it("adds MEDIUM item for conflicted build pack", () => {
    const data: OSData = {
      ...baseData(),
      buildPacks: [{
        id: "bp-1", projectId: "proj-a", version: 1, status: "CONFLICT" as const,
        siteBlueprintArtifactId: null, designSystemArtifactId: null, contentPackArtifactId: null,
        pages: [], constraints: [], permissions: [], acceptanceCriteria: [], evidenceRequirements: [],
        conflicts: [{ kind: "missing_required_content" as any, detail: "Missing hero content", artifactIds: [] }],
        assembledByJobId: null, assembledAt: null, supersededById: null, createdAt: null,
      }],
    };
    const queue = deriveAttentionQueue(data);
    const item = queue.find((i) => i.kind === "build_pack_conflict");
    expect(item).toBeDefined();
    expect(item!.urgency).toBe("MEDIUM");
    expect(item!.detail).toContain("Missing hero content");
  });
});

describe("deriveAttentionQueue — ordering", () => {
  it("orders CRITICAL before MEDIUM", () => {
    const data: OSData = {
      ...baseData(),
      agentJobs: [{
        id: "job-1", projectId: "proj-a", agentId: "a1",
        taskType: "SITE_DISCOVERY" as any, instructions: "",
        inputArtifactIds: [], availableToolIds: [],
        requiredOutputSchema: "discovery_report@1", requiredCapabilities: [],
        preferredProvider: "claude", fallbackProviders: [],
        permissionLevel: "GREEN", status: "NEEDS_A_HAND",
        outputArtifactId: null, handoffId: null, requestedById: null,
        createdAt: null, updatedAt: null, startedAt: null, completedAt: null,
      }],
      qaItems: [{
        id: "qa-1", projectId: "proj-a",
        title: "P1 defect", severity: "P1" as const,
        category: "FUNCTIONALITY" as any, description: "P1",
        status: "OPEN" as const, createdAt: null, resolvedAt: null,
      }],
    };
    const queue = deriveAttentionQueue(data);
    const urgencies = queue.map((i) => i.urgency);
    const criticalIdx = urgencies.indexOf("CRITICAL");
    const mediumIdx = urgencies.indexOf("MEDIUM");
    expect(criticalIdx).toBeLessThan(mediumIdx);
  });
});

describe("projectAttentionQueue", () => {
  it("filters to items for the given project only", () => {
    const data: OSData = {
      ...baseData(),
      agentJobs: [
        {
          id: "job-a", projectId: "proj-a", agentId: "a1",
          taskType: "SITE_DISCOVERY" as any, instructions: "",
          inputArtifactIds: [], availableToolIds: [],
          requiredOutputSchema: "discovery_report@1", requiredCapabilities: [],
          preferredProvider: "claude", fallbackProviders: [],
          permissionLevel: "GREEN", status: "NEEDS_A_HAND",
          outputArtifactId: null, handoffId: null, requestedById: null,
          createdAt: null, updatedAt: null, startedAt: null, completedAt: null,
        },
        {
          id: "job-b", projectId: "proj-b", agentId: "a1",
          taskType: "SITE_DISCOVERY" as any, instructions: "",
          inputArtifactIds: [], availableToolIds: [],
          requiredOutputSchema: "discovery_report@1", requiredCapabilities: [],
          preferredProvider: "claude", fallbackProviders: [],
          permissionLevel: "GREEN", status: "NEEDS_A_HAND",
          outputArtifactId: null, handoffId: null, requestedById: null,
          createdAt: null, updatedAt: null, startedAt: null, completedAt: null,
        },
      ],
    };
    const queue = projectAttentionQueue(data, "proj-a");
    expect(queue.every((i) => i.projectId === "proj-a" || i.projectId === null)).toBe(true);
    expect(queue.some((i) => i.sourceIds.includes("job-a"))).toBe(true);
    expect(queue.some((i) => i.sourceIds.includes("job-b"))).toBe(false);
  });
});

describe("projectClear", () => {
  it("returns true for project with no attention items", () => {
    expect(projectClear(baseData(), "proj-x")).toBe(true);
  });

  it("returns false when there are blockers", () => {
    const data: OSData = {
      ...baseData(),
      launchHolds: [{
        id: "hold-1", projectId: "proj-x",
        title: "Waiting", owner: "Client" as const,
        resolved: false, resolvedAt: null, createdAt: null,
      }],
    };
    expect(projectClear(data, "proj-x")).toBe(false);
  });
});

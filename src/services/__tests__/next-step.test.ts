import { describe, it, expect } from "vitest";
import { resolveNextStep } from "../next-step";
import type { OSData, Project } from "@/data/types";
import { EMPTY } from "@/gateway/core";

function makeProject(id: string, state: string): Project {
  return {
    id, clientId: "client-1", name: "Test Project",
    state: state as any,
    createdAt: null, updatedAt: null,
  } as Project;
}

const baseData = (projectState: string, projectId = "proj-1"): OSData => ({
  ...EMPTY,
  projects: [makeProject(projectId, projectState)],
});

describe("resolveNextStep — unknown project", () => {
  it("returns BLOCKED for unknown project", () => {
    const result = resolveNextStep(EMPTY, "does-not-exist");
    expect(result.outcome).toBe("BLOCKED");
    expect(result.blocker).toMatch(/PROJECT_NOT_FOUND/);
  });
});

describe("resolveNextStep — terminal states", () => {
  it("returns COMPLETE for LIVE project", () => {
    const result = resolveNextStep(baseData("LIVE"), "proj-1");
    expect(result.outcome).toBe("COMPLETE");
  });

  it("returns COMPLETE for ARCHIVED project", () => {
    const result = resolveNextStep(baseData("ARCHIVED"), "proj-1");
    expect(result.outcome).toBe("COMPLETE");
  });
});

describe("resolveNextStep — NEEDS_A_HAND cross-cutting blocker", () => {
  it("blocks any state when a NEEDS_A_HAND job exists", () => {
    const data: OSData = {
      ...baseData("STRATEGY"),
      agentJobs: [{
        id: "job-1", projectId: "proj-1", agentId: "a1",
        taskType: "SITE_DISCOVERY" as any, instructions: "",
        inputArtifactIds: [], availableToolIds: [],
        requiredOutputSchema: "discovery_report@1", requiredCapabilities: [],
        preferredProvider: "claude", fallbackProviders: [],
        permissionLevel: "GREEN", status: "NEEDS_A_HAND",
        outputArtifactId: null, handoffId: null, requestedById: null,
        createdAt: null, updatedAt: null, startedAt: null, completedAt: null,
      }],
    };
    const result = resolveNextStep(data, "proj-1");
    expect(result.outcome).toBe("BLOCKED");
    expect(result.blocker).toMatch(/NEEDS_A_HAND/);
  });
});

describe("resolveNextStep — launch hold blocker", () => {
  it("returns HUMAN_ACTION when open launch hold exists", () => {
    const data: OSData = {
      ...baseData("DESIGN"),
      launchHolds: [{
        id: "hold-1", projectId: "proj-1",
        title: "Waiting", owner: "Client" as const,
        resolved: false, resolvedAt: null, createdAt: null,
      }],
    };
    const result = resolveNextStep(data, "proj-1");
    expect(result.outcome).toBe("HUMAN_ACTION");
    expect(result.blocker).toMatch(/hold/i);
  });

  it("does NOT block when hold is resolved", () => {
    const data: OSData = {
      ...baseData("DISCOVERY"),
      launchHolds: [{
        id: "hold-2", projectId: "proj-1",
        title: "Resolved", owner: "Creative Touch" as const,
        resolved: true, resolvedAt: "2025-01-01T00:00:00Z", createdAt: null,
      }],
    };
    const result = resolveNextStep(data, "proj-1");
    expect(result.outcome).toBe("AGENT_ACTION");
    expect(result.agentCode).toBe("A01");
  });
});

describe("resolveNextStep — DISCOVERY", () => {
  it("routes to A01", () => {
    const result = resolveNextStep(baseData("DISCOVERY"), "proj-1");
    expect(result.outcome).toBe("AGENT_ACTION");
    expect(result.agentCode).toBe("A01");
    expect(result.forState).toBe("DISCOVERY");
  });
});

describe("resolveNextStep — STRATEGY", () => {
  it("routes to A02", () => {
    const result = resolveNextStep(baseData("STRATEGY"), "proj-1");
    expect(result.outcome).toBe("AGENT_ACTION");
    expect(result.agentCode).toBe("A02");
  });
});

describe("resolveNextStep — DESIGN state without blueprint", () => {
  it("blocks when no FINAL site_blueprint exists", () => {
    const result = resolveNextStep(baseData("DESIGN"), "proj-1");
    expect(result.outcome).toBe("BLOCKED");
    expect(result.blocker).toMatch(/site_blueprint/i);
  });
});

describe("resolveNextStep — DESIGN state with blueprint", () => {
  it("routes to A03 when blueprint exists but no design system", () => {
    const data: OSData = {
      ...baseData("DESIGN"),
      artifacts: [{
        id: "art-1", projectId: "proj-1", type: "site_blueprint" as any,
        title: "Blueprint", status: "FINAL" as any, version: 1,
        createdByAgentId: null, createdByProvider: null,
        jobId: undefined, ticketId: undefined, content: {},
        storageLocation: null, schemaVersion: null, supersedesArtifactId: null,
        createdAt: null, updatedAt: null,
      } as any],
    };
    const result = resolveNextStep(data, "proj-1");
    expect(result.outcome).toBe("AGENT_ACTION");
    expect(result.agentCode).toBe("A03");
  });
});

describe("resolveNextStep — QA state", () => {
  it("routes to A06 when no QA items exist yet", () => {
    const result = resolveNextStep(baseData("QA"), "proj-1");
    expect(result.outcome).toBe("AGENT_ACTION");
    expect(result.agentCode).toBe("A06");
  });

  it("blocks when P0 QA items are unresolved", () => {
    const data: OSData = {
      ...baseData("QA"),
      qaItems: [{
        id: "qa-1", projectId: "proj-1",
        title: "Crash on load", severity: "P0" as const,
        category: "PERFORMANCE" as any, description: "Fatal error",
        status: "OPEN" as const, createdAt: null, resolvedAt: null,
      }],
    };
    const result = resolveNextStep(data, "proj-1");
    expect(result.outcome).toBe("BLOCKED");
    expect(result.blocker).toMatch(/CRITICAL|P0/);
  });

  it("requests human approval when all P0 items are VERIFIED", () => {
    const data: OSData = {
      ...baseData("QA"),
      qaItems: [{
        id: "qa-2", projectId: "proj-1",
        title: "Fixed crash", severity: "P0" as const,
        category: "PERFORMANCE" as any, description: "Fixed",
        status: "VERIFIED" as const, createdAt: null, resolvedAt: "2025-01-01T00:00:00Z",
      }],
    };
    const result = resolveNextStep(data, "proj-1");
    expect(result.outcome).toBe("HUMAN_ACTION");
  });
});

describe("resolveNextStep — READY_TO_LAUNCH", () => {
  it("requires human approval", () => {
    const result = resolveNextStep(baseData("READY_TO_LAUNCH"), "proj-1");
    expect(result.outcome).toBe("HUMAN_ACTION");
    expect(result.blocker).toMatch(/launch/i);
  });
});

describe("resolveNextStep — CLIENT_REVIEW with unconfirmed CRs", () => {
  it("requires human to classify change requests", () => {
    const data: OSData = {
      ...baseData("CLIENT_REVIEW"),
      changeRequests: [{
        id: "cr-1", projectId: "proj-1", revisionRoundId: null,
        title: "New page", description: "Add about page",
        classification: "NEEDS_DECISION" as any,
        recommendedByAgentId: null, classifiedByLeadId: null, classifiedByLeadName: null,
        confirmedAt: null, ticketIds: [], createdAt: null,
      }],
    };
    const result = resolveNextStep(data, "proj-1");
    expect(result.outcome).toBe("HUMAN_ACTION");
    expect(result.blocker).toMatch(/change request/i);
  });
});

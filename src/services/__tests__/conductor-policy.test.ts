import { describe, it, expect } from "vitest";
import {
  conductorCanApproveGate,
  conductorCanPerformAction,
  conductorCanPromoteKnowledge,
  conductorCanChangeSkillStatus,
  conductorCanDecideClientScope,
  conductorCanApproveLaunch,
  conductorCanAdvanceState,
  conductorCanTriggerJob,
  isConductorAgent,
  CONDUCTOR_AGENT_CODE,
} from "../conductor-policy";
import type { OSData } from "@/data/types";
import { EMPTY } from "@/gateway/core";

const baseData = (): OSData => ({ ...EMPTY });

describe("conductor identity", () => {
  it("ORCH is the conductor agent", () => {
    expect(isConductorAgent("ORCH")).toBe(true);
  });

  it("specialist agents are not conductor", () => {
    const agents = ["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08"] as const;
    for (const code of agents) {
      expect(isConductorAgent(code)).toBe(false);
    }
  });

  it("CONDUCTOR_AGENT_CODE is ORCH", () => {
    expect(CONDUCTOR_AGENT_CODE).toBe("ORCH");
  });
});

describe("conductorCanApproveGate", () => {
  it("always returns not allowed", () => {
    const d = conductorCanApproveGate("gate-123");
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/human operator/i);
  });
});

describe("conductorCanPerformAction", () => {
  it("allows GREEN actions", () => {
    expect(conductorCanPerformAction("GREEN").allowed).toBe(true);
  });

  it("rejects AMBER actions", () => {
    const d = conductorCanPerformAction("AMBER");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("AMBER");
  });

  it("rejects RED actions", () => {
    const d = conductorCanPerformAction("RED");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("RED");
  });
});

describe("conductorCanTriggerJob", () => {
  it("allows triggering GREEN jobs", () => {
    expect(conductorCanTriggerJob("GREEN").allowed).toBe(true);
  });

  it("cannot trigger AMBER or RED jobs", () => {
    expect(conductorCanTriggerJob("AMBER").allowed).toBe(false);
    expect(conductorCanTriggerJob("RED").allowed).toBe(false);
  });
});

describe("conductorCanPromoteKnowledge", () => {
  it("cannot promote to DOCTRINE", () => {
    expect(conductorCanPromoteKnowledge("DOCTRINE").allowed).toBe(false);
  });

  it("cannot promote to AGENCY", () => {
    expect(conductorCanPromoteKnowledge("AGENCY").allowed).toBe(false);
  });

  it("cannot promote to PROJECT", () => {
    expect(conductorCanPromoteKnowledge("PROJECT").allowed).toBe(false);
  });

  it("cannot promote to TASK", () => {
    expect(conductorCanPromoteKnowledge("TASK").allowed).toBe(false);
  });
});

describe("conductorCanChangeSkillStatus", () => {
  it("always returns not allowed", () => {
    expect(conductorCanChangeSkillStatus().allowed).toBe(false);
  });
});

describe("conductorCanDecideClientScope", () => {
  it("always returns not allowed", () => {
    expect(conductorCanDecideClientScope().allowed).toBe(false);
    expect(conductorCanDecideClientScope().reason).toMatch(/project lead/i);
  });
});

describe("conductorCanApproveLaunch", () => {
  it("always returns not allowed", () => {
    expect(conductorCanApproveLaunch().allowed).toBe(false);
    expect(conductorCanApproveLaunch().reason).toMatch(/human operator/i);
  });
});

describe("conductorCanAdvanceState", () => {
  it("allows advancing to intermediate states when no blockers", () => {
    const data = baseData();
    const d = conductorCanAdvanceState(data, "proj-1", "DESIGN");
    expect(d.allowed).toBe(true);
  });

  it("blocks advancing to READY_TO_LAUNCH", () => {
    const data = baseData();
    const d = conductorCanAdvanceState(data, "proj-1", "READY_TO_LAUNCH");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("READY_TO_LAUNCH");
  });

  it("blocks advancing to LIVE", () => {
    const data = baseData();
    const d = conductorCanAdvanceState(data, "proj-1", "LIVE");
    expect(d.allowed).toBe(false);
  });

  it("blocks when pending approvals exist", () => {
    const data = {
      ...baseData(),
      jobApprovals: [{
        id: "appr-1", jobId: "job-1", projectId: "proj-1",
        agentId: "a1", kind: "APPROVAL" as const, permissionLevel: "AMBER" as const,
        actionFingerprint: "fp", requestedAction: "test",
        requestedById: "u1", requestedByName: "User",
        approvedById: null, approvedByName: null, approvedByRole: null,
        status: "PENDING" as const, createdAt: null, decidedAt: null, consumedAt: null, expiresAt: null,
      }],
    };
    const d = conductorCanAdvanceState(data, "proj-1", "STRATEGY");
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/pending approval/i);
  });

  it("blocks when open launch holds exist", () => {
    const data = {
      ...baseData(),
      launchHolds: [{
        id: "hold-1", projectId: "proj-1",
        title: "Waiting on client", detail: "test",
        owner: "Client" as const, resolved: false, resolvedAt: null, createdAt: null,
      }],
    };
    const d = conductorCanAdvanceState(data, "proj-1", "QA");
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/launch hold/i);
  });
});

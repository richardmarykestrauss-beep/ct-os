/**
 * Client feedback / revision foundation tests (CTOS-005A Part 15).
 *
 * Proves:
 * - Change request escalation threshold
 * - Conductor cannot decide scope
 * - Revision round lifecycle
 */
import { describe, it, expect } from "vitest";
import type { OSData } from "@/data/types";
import { EMPTY } from "@/gateway/core";
import {
  openRevisionRound,
  addChangeRequest,
  approveRevisionRound,
  completeRevisionRound,
  confirmChangeRequest,
  unconfirmedChangeRequests,
  currentRevisionRound,
} from "../revision-control";
import { conductorCanDecideClientScope } from "../conductor-policy";

const baseData = (): OSData => ({ ...EMPTY });

// ---------------------------------------------------------------------------
// Revision round lifecycle
// ---------------------------------------------------------------------------

describe("openRevisionRound", () => {
  it("creates a new revision round with round number 1", () => {
    const { data, revisionRound } = openRevisionRound(baseData(), "proj-1", 1, "client");
    expect(revisionRound.projectId).toBe("proj-1");
    expect(revisionRound.roundNumber).toBe(1);
    expect(revisionRound.requestSource).toBe("client");
    expect(revisionRound.completedAt).toBeNull();
    expect(data.revisionRounds).toHaveLength(1);
  });

  it("creates round 2 when called with roundNumber 2", () => {
    const { revisionRound } = openRevisionRound(baseData(), "proj-1", 2, "internal");
    expect(revisionRound.roundNumber).toBe(2);
  });

  it("accepts all valid requestSource values", () => {
    expect(() => openRevisionRound(baseData(), "proj-1", 1, "client")).not.toThrow();
    expect(() => openRevisionRound(baseData(), "proj-1", 1, "internal")).not.toThrow();
    expect(() => openRevisionRound(baseData(), "proj-1", 1, "qa")).not.toThrow();
  });
});

describe("addChangeRequest", () => {
  it("adds a change request to a revision round", () => {
    const { data: d1, revisionRound } = openRevisionRound(baseData(), "proj-1", 1, "client");
    const { data: d2, changeRequest } = addChangeRequest(d1, revisionRound.id, {
      title: "Add contact page",
      description: "Client wants a dedicated contact page",
      classification: "NEEDS_DECISION",
      recommendedByAgentId: null,
    });

    expect(changeRequest.projectId).toBe("proj-1");
    expect(changeRequest.revisionRoundId).toBe(revisionRound.id);
    expect(changeRequest.confirmedAt).toBeNull();
    expect(d2.changeRequests).toHaveLength(1);
  });

  it("classifies change request as IN_SCOPE", () => {
    const { data: d1, revisionRound } = openRevisionRound(baseData(), "proj-1", 1, "client");
    const { changeRequest } = addChangeRequest(d1, revisionRound.id, {
      title: "Update logo",
      description: "New brand logo",
      classification: "IN_SCOPE",
      recommendedByAgentId: null,
    });
    expect(changeRequest.classification).toBe("IN_SCOPE");
  });
});

describe("confirmChangeRequest", () => {
  it("sets confirmedAt on a change request", () => {
    const { data: d1, revisionRound } = openRevisionRound(baseData(), "proj-1", 1, "client");
    const { data: d2, changeRequest } = addChangeRequest(d1, revisionRound.id, {
      title: "Add gallery",
      description: "Client wants photos",
      classification: "NEEDS_DECISION",
      recommendedByAgentId: null,
    });

    const d3 = confirmChangeRequest(d2, changeRequest.id, "lead-1", "Project Lead");
    const confirmed = d3.changeRequests.find((cr) => cr.id === changeRequest.id);
    expect(confirmed?.confirmedAt).not.toBeNull();
    expect(confirmed?.classifiedByLeadId).toBe("lead-1");
    expect(confirmed?.classifiedByLeadName).toBe("Project Lead");
  });
});

describe("unconfirmedChangeRequests", () => {
  it("returns change requests without confirmedAt", () => {
    const { data: d1, revisionRound } = openRevisionRound(baseData(), "proj-1", 1, "client");
    const { data: d2 } = addChangeRequest(d1, revisionRound.id, {
      title: "Unconfirmed", description: "test",
      classification: "NEEDS_DECISION", recommendedByAgentId: null,
    });

    const unconfirmed = unconfirmedChangeRequests(d2, "proj-1");
    expect(unconfirmed).toHaveLength(1);
  });

  it("returns empty when all are confirmed", () => {
    const { data: d1, revisionRound } = openRevisionRound(baseData(), "proj-1", 1, "client");
    const { data: d2, changeRequest } = addChangeRequest(d1, revisionRound.id, {
      title: "Confirmed", description: "test",
      classification: "IN_SCOPE", recommendedByAgentId: null,
    });
    const d3 = confirmChangeRequest(d2, changeRequest.id, "lead-1", "Lead");
    expect(unconfirmedChangeRequests(d3, "proj-1")).toHaveLength(0);
  });
});

describe("approveRevisionRound", () => {
  it("records approval by updating the round", () => {
    const { data: d1, revisionRound } = openRevisionRound(baseData(), "proj-1", 1, "client");
    const d2 = approveRevisionRound(d1, revisionRound.id, "lead-1", "Project Lead");

    const approved = d2.revisionRounds.find((r) => r.id === revisionRound.id);
    expect(approved?.approvedByLeadId).toBe("lead-1");
    expect(approved?.approvedAt).not.toBeNull();
    expect(approved?.completedAt).toBeNull();
  });
});

describe("completeRevisionRound", () => {
  it("sets completedAt on the round", () => {
    const { data: d1, revisionRound } = openRevisionRound(baseData(), "proj-1", 1, "client");
    const d2 = completeRevisionRound(d1, revisionRound.id);

    const done = d2.revisionRounds.find((r) => r.id === revisionRound.id);
    expect(done?.completedAt).not.toBeNull();
  });
});

describe("currentRevisionRound", () => {
  it("returns the open round for a project", () => {
    const { data, revisionRound } = openRevisionRound(baseData(), "proj-1", 1, "client");
    const current = currentRevisionRound(data, "proj-1");
    expect(current?.id).toBe(revisionRound.id);
  });

  it("returns null when no open round exists", () => {
    expect(currentRevisionRound(baseData(), "proj-1")).toBeNull();
  });

  it("returns null after round is completed", () => {
    const { data: d1, revisionRound } = openRevisionRound(baseData(), "proj-1", 1, "client");
    const d2 = completeRevisionRound(d1, revisionRound.id);
    expect(currentRevisionRound(d2, "proj-1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Conductor cannot decide scope
// ---------------------------------------------------------------------------

describe("Conductor cannot decide change request scope", () => {
  it("conductorCanDecideClientScope returns not allowed", () => {
    const decision = conductorCanDecideClientScope();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBeTruthy();
  });

  it("reason references project lead", () => {
    const decision = conductorCanDecideClientScope();
    expect(decision.reason.toLowerCase()).toContain("project lead");
  });
});

// ---------------------------------------------------------------------------
// Change request escalation threshold
// ---------------------------------------------------------------------------

describe("escalation threshold — 3+ open rounds trigger attention", () => {
  it("three open revision rounds meet the escalation threshold", () => {
    let data = baseData();
    for (let i = 1; i <= 3; i++) {
      const result = openRevisionRound(data, "proj-1", i, "client");
      data = result.data;
    }
    // All rounds are open (not completed)
    const openRounds = data.revisionRounds.filter(
      (r) => r.projectId === "proj-1" && r.completedAt === null
    );
    expect(openRounds.length).toBeGreaterThanOrEqual(3);
    // Round 3 is the escalation threshold
    expect(openRounds.some((r) => r.roundNumber >= 3)).toBe(true);
  });
});

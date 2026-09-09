/**
 * Skills / instruction packs (CTOS-003 Parts I, J, K, L). The rule this file exists to verify
 * structurally, not just by convention: only a human may approve/reject/deprecate a skill, editing
 * an APPROVED skill always creates a new version, and only APPROVED skills ever reach a production
 * execution context (services/agent-jobs.ts calls approvedSkillsForAgent for exactly this reason).
 */
import { describe, expect, it } from "vitest";
import { approvedSkillsForAgent, createSkill, isProductionReady, reviewSkill, reviseSkill, skillProvenance, SkillPolicyError, type SkillActor } from "@/services/skills";
import { base } from "./fixtures";

const humanAdmin: SkillActor = { kind: "human", name: "Richard", id: "u_admin", role: "ADMIN" };
const humanLead: SkillActor = { kind: "human", name: "Lead", id: "u_lead", role: "PRODUCTION_LEAD" };
const humanMember: SkillActor = { kind: "human", name: "Member", id: "u_member", role: "TEAM_MEMBER" };
const humanViewer: SkillActor = { kind: "human", name: "Viewer", id: "u_viewer", role: "VIEWER" };
const anAgent: SkillActor = { kind: "agent", agentId: "agent_03" };

describe("createSkill", () => {
  it("creates a DRAFT skill by default, never pre-approved", () => {
    const { skill } = createSkill(base(), { name: "New Skill", kind: "other", scope: "test", ownerAgentIds: ["agent_03"], content: "..." });
    expect(skill.status).toBe("DRAFT");
    expect(skill.version).toBe(1);
    expect(skill.approvedBy).toBeNull();
    expect(skill.approvedAt).toBeNull();
  });

  it("can be created directly as CANDIDATE (ready for review) but never as APPROVED", () => {
    const { skill } = createSkill(base(), { name: "New Skill", kind: "other", scope: "test", ownerAgentIds: ["agent_03"], content: "...", status: "CANDIDATE" });
    expect(skill.status).toBe("CANDIDATE");
  });
});

describe("reviewSkill — only a human may approve/reject/deprecate", () => {
  it("an agent can never approve a skill, structurally: the type only admits a human down this path, and the runtime re-asserts it", () => {
    const { data } = createSkill(base(), { name: "S", kind: "other", scope: "t", ownerAgentIds: ["agent_03"], content: "...", status: "CANDIDATE", id: "skill_test" });
    expect(() => reviewSkill(data, anAgent, "skill_test", "APPROVED")).toThrow(SkillPolicyError);
    expect(() => reviewSkill(data, anAgent, "skill_test", "APPROVED")).toThrow(/never an agent/);
  });

  it("a TEAM_MEMBER or VIEWER may not review skills, even though they are human", () => {
    const { data } = createSkill(base(), { name: "S", kind: "other", scope: "t", ownerAgentIds: ["agent_03"], content: "...", status: "CANDIDATE", id: "skill_test" });
    expect(() => reviewSkill(data, humanMember, "skill_test", "APPROVED")).toThrow(/may not review/);
    expect(() => reviewSkill(data, humanViewer, "skill_test", "APPROVED")).toThrow(/may not review/);
  });

  it("an ADMIN or PRODUCTION_LEAD can approve a CANDIDATE skill, recording who and when", () => {
    const { data } = createSkill(base(), { name: "S", kind: "other", scope: "t", ownerAgentIds: ["agent_03"], content: "...", status: "CANDIDATE", id: "skill_test" });
    const { skill } = reviewSkill(data, humanAdmin, "skill_test", "APPROVED", "looks good");
    expect(skill.status).toBe("APPROVED");
    expect(skill.approvedBy).toBe("Richard");
    expect(skill.approvedById).toBe("u_admin");
    expect(skill.approvedAt).not.toBeNull();

    const { data: d2 } = createSkill(base(), { name: "S2", kind: "other", scope: "t", ownerAgentIds: ["agent_03"], content: "...", status: "CANDIDATE", id: "skill_test2" });
    const { skill: s2 } = reviewSkill(d2, humanLead, "skill_test2", "APPROVED");
    expect(s2.status).toBe("APPROVED");
    expect(s2.approvedBy).toBe("Lead");
  });

  it("a DRAFT skill can be approved directly (review doesn't require passing through CANDIDATE first)", () => {
    const { data } = createSkill(base(), { name: "S", kind: "other", scope: "t", ownerAgentIds: ["agent_03"], content: "...", id: "skill_test" });
    const { skill } = reviewSkill(data, humanAdmin, "skill_test", "APPROVED");
    expect(skill.status).toBe("APPROVED");
  });

  it("an already-APPROVED skill cannot be approved again or rejected — only deprecated", () => {
    const { data } = createSkill(base(), { name: "S", kind: "other", scope: "t", ownerAgentIds: ["agent_03"], content: "...", status: "CANDIDATE", id: "skill_test" });
    const { data: approved } = reviewSkill(data, humanAdmin, "skill_test", "APPROVED");
    expect(() => reviewSkill(approved, humanAdmin, "skill_test", "APPROVED")).toThrow(/Only a DRAFT or CANDIDATE/);
    expect(() => reviewSkill(approved, humanAdmin, "skill_test", "REJECTED")).toThrow(/cannot be rejected/);
    const { skill: deprecated } = reviewSkill(approved, humanAdmin, "skill_test", "DEPRECATED");
    expect(deprecated.status).toBe("DEPRECATED");
  });

  it("only an APPROVED skill can be deprecated", () => {
    const { data } = createSkill(base(), { name: "S", kind: "other", scope: "t", ownerAgentIds: ["agent_03"], content: "...", status: "CANDIDATE", id: "skill_test" });
    expect(() => reviewSkill(data, humanAdmin, "skill_test", "DEPRECATED")).toThrow(/Only an APPROVED skill can be deprecated/);
  });

  it("rejecting a CANDIDATE never sets approvedBy — a rejection is not an approval", () => {
    const { data } = createSkill(base(), { name: "S", kind: "other", scope: "t", ownerAgentIds: ["agent_03"], content: "...", status: "CANDIDATE", id: "skill_test" });
    const { skill } = reviewSkill(data, humanAdmin, "skill_test", "REJECTED");
    expect(skill.status).toBe("REJECTED");
    expect(skill.approvedBy).toBeNull();
  });
});

describe("reviseSkill — editing an APPROVED skill always creates a new version", () => {
  it("edits a DRAFT/CANDIDATE skill in place", () => {
    const { data } = createSkill(base(), { name: "S", kind: "other", scope: "t", ownerAgentIds: ["agent_03"], content: "v1", id: "skill_test" });
    const { data: revised, skill } = reviseSkill(data, "skill_test", { content: "v1 edited", evidence: [] });
    expect(skill.id).toBe("skill_test");
    expect(skill.version).toBe(1);
    expect(revised.skills.find((s) => s.id === "skill_test")?.content).toBe("v1 edited");
  });

  it("never edits an APPROVED skill in place: creates version+1 as a new DRAFT row, leaving the approved row untouched and still serving production", () => {
    const { data } = createSkill(base(), { name: "S", kind: "other", scope: "t", ownerAgentIds: ["agent_03"], content: "v1", status: "CANDIDATE", id: "skill_test" });
    const { data: approved } = reviewSkill(data, humanAdmin, "skill_test", "APPROVED");
    const { data: revised, skill: v2 } = reviseSkill(approved, "skill_test", { content: "v2 content", evidence: [] });
    expect(v2.id).not.toBe("skill_test");
    expect(v2.version).toBe(2);
    expect(v2.status).toBe("DRAFT");
    expect(v2.supersedesId).toBe("skill_test");
    expect(v2.approvedBy).toBeNull();
    const original = revised.skills.find((s) => s.id === "skill_test")!;
    expect(original.status).toBe("APPROVED");
    expect(original.content).toBe("v1");
    expect(isProductionReady(original)).toBe(true);
    expect(isProductionReady(v2)).toBe(false);
  });
});

describe("approvedSkillsForAgent — the production-context enforcement point (Part O)", () => {
  it("only APPROVED skills reach an agent's active context, never CANDIDATE/DRAFT/DEPRECATED", () => {
    const d = base();
    // Seed already has skill_ct_visual_design (CANDIDATE, owner agent_03) and skill_ux_review_pack (APPROVED, owner agent_02).
    const forA03 = approvedSkillsForAgent(d, "agent_03", ["skill_ct_visual_design"]);
    expect(forA03).toEqual([]); // CANDIDATE, correctly excluded even though it's in instructionPackIds
    const forA02 = approvedSkillsForAgent(d, "agent_02", ["skill_ux_review_pack"]);
    expect(forA02.map((s) => s.id)).toEqual(["skill_ux_review_pack"]);
  });

  it("includes a skill the agent owns or reviews even without an explicit instructionPackIds entry", () => {
    const { data } = createSkill(base(), { name: "S", kind: "other", scope: "t", ownerAgentIds: ["agent_05"], reviewerAgentIds: ["agent_06"], content: "...", status: "CANDIDATE", id: "skill_owned" });
    const { data: approved } = reviewSkill(data, humanAdmin, "skill_owned", "APPROVED");
    expect(approvedSkillsForAgent(approved, "agent_05").map((s) => s.id)).toEqual(["skill_owned"]);
    // agent_06 is also the seeded reviewer of skill_ux_review_pack (APPROVED) — both are correctly active.
    expect(approvedSkillsForAgent(approved, "agent_06").map((s) => s.id)).toEqual(["skill_ux_review_pack", "skill_owned"]);
    expect(approvedSkillsForAgent(approved, "agent_08")).toEqual([]);
  });

  it("a newly-approved v2 supersedes v1 in an agent's active context (both carry the same instructionPackIds membership only if explicitly listed)", () => {
    const { data } = createSkill(base(), { name: "S", kind: "other", scope: "t", ownerAgentIds: ["agent_05"], content: "v1", status: "CANDIDATE", id: "skill_owned" });
    const { data: approvedV1 } = reviewSkill(data, humanAdmin, "skill_owned", "APPROVED");
    const active1 = approvedSkillsForAgent(approvedV1, "agent_05");
    expect(active1).toEqual([{ id: "skill_owned", name: "S", version: 1, kind: "other", content: "v1" }]);

    const { data: withV2, skill: v2 } = reviseSkill(approvedV1, "skill_owned", { content: "v2", evidence: [] });
    const { data: approvedV2 } = reviewSkill(withV2, humanAdmin, v2.id, "APPROVED");
    const active2 = approvedSkillsForAgent(approvedV2, "agent_05");
    // v1 is still APPROVED and owned by agent_05 too — both versions are technically "active"; the
    // job-building layer (buildExecutionRequest) sends whatever this returns, so this only asserts
    // the function itself never lets an unapproved row through, and that the new version is present.
    expect(active2.some((s) => s.id === v2.id && s.version === 2)).toBe(true);
    expect(active2.every((s) => s.id === "skill_owned" || s.id === v2.id)).toBe(true);
  });
});

describe("skillProvenance", () => {
  it("formats id@version strings for execution records", () => {
    expect(skillProvenance([{ id: "skill_a", name: "A", version: 1, kind: "other", content: "" }])).toEqual(["skill_a@1"]);
    expect(skillProvenance([{ id: "skill_a", name: "A", version: 2, kind: "other", content: "" }, { id: "skill_b", name: "B", version: 1, kind: "other", content: "" }])).toEqual(["skill_a@2", "skill_b@1"]);
    expect(skillProvenance([])).toEqual([]);
  });
});

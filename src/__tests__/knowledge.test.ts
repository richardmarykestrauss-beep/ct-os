import { describe, expect, it } from "vitest";
import { seedData } from "@/data/seed";
import { clearTaskKnowledge, createKnowledgeItem, knowledgeForJob, proposeLesson, reviewKnowledgeItem } from "@/services/knowledge";

const base = () => structuredClone(seedData);
const human = { kind: "human" as const, name: "Production Lead" };
const agent08 = { kind: "agent" as const, agentId: "agent_08" };

describe("intelligence model", () => {
  it("U-Proof lessons are seeded as CANDIDATE, never approved, with evidence and no invented dates", () => {
    const lessons = seedData.knowledgeItems.filter((k) => k.id.startsWith("kn_up_"));
    expect(lessons.length).toBe(10);
    for (const k of lessons) {
      expect(k.status).toBe("CANDIDATE");
      expect(k.scope).toBe("AGENCY");
      expect(k.proposedByAgentId).toBe("agent_08");
      expect(k.evidence.length).toBeGreaterThan(0);
      expect(k.createdAt).toBeNull();
      expect(k.reviewedBy).toBeNull();
    }
    expect(seedData.agentLessons.length).toBe(10);
    expect(seedData.agentLessons.every((l) => l.status === "CANDIDATE" && l.knowledgeItemId.startsWith("kn_up_"))).toBe(true);
  });

  it("an agent proposal always lands as CANDIDATE with a ledger entry", () => {
    const { data, item, lesson } = proposeLesson(base(), {
      agentId: "agent_08",
      projectId: "proj_uproof",
      title: "Verify SMTP before contact-form QA sign-off",
      content: "Contact form QA is incomplete until a real delivery is observed.",
      category: "qa",
      evidence: ["hold_up_4"],
      proposedScope: "AGENCY",
      confidence: 0.9,
    });
    expect(item.status).toBe("CANDIDATE");
    expect(item.proposedByAgentId).toBe("agent_08");
    expect(lesson.knowledgeItemId).toBe(item.id);
    expect(lesson.status).toBe("CANDIDATE");
    expect(data.knowledgeItems.at(-1)).toEqual(item);
  });

  it("agents cannot approve, write DOCTRINE, or create APPROVED agency knowledge", () => {
    const d = base();
    expect(() => reviewKnowledgeItem(d, agent08 as never, "kn_up_backup_before_mutation", "APPROVED")).toThrow(/Only a human/);
    expect(() => createKnowledgeItem(d, agent08, { scope: "DOCTRINE", category: "safety", title: "x", content: "y" })).toThrow(/Only a human/);
    const { item } = createKnowledgeItem(d, agent08, { scope: "AGENCY", category: "build", title: "x", content: "y" });
    expect(item.status).toBe("CANDIDATE");
  });

  it("human approval promotes a candidate; approval can narrow scope to PROJECT", () => {
    const d = base();
    const approved = reviewKnowledgeItem(d, human, "kn_up_backup_before_mutation", "APPROVED");
    expect(approved.item.status).toBe("APPROVED");
    expect(approved.item.reviewedBy).toBe("Production Lead");
    expect(approved.data.agentLessons.find((l) => l.knowledgeItemId === "kn_up_backup_before_mutation")?.status).toBe("APPROVED");
    const narrowed = reviewKnowledgeItem(d, human, "kn_up_wp_slash_semantics", "APPROVED", { scope: "PROJECT", projectId: "proj_uproof" });
    expect(narrowed.item.scope).toBe("PROJECT");
    expect(narrowed.item.projectId).toBe("proj_uproof");
    expect(() => reviewKnowledgeItem(approved.data, human, "kn_up_backup_before_mutation", "APPROVED")).toThrow(/Only CANDIDATE/);
    const deprecated = reviewKnowledgeItem(approved.data, human, "kn_up_backup_before_mutation", "DEPRECATED");
    expect(deprecated.item.status).toBe("DEPRECATED");
  });

  it("knowledgeForJob returns doctrine + approved agency + project facts + this job's task context only", () => {
    let d = base();
    d = createKnowledgeItem(d, human, { scope: "PROJECT", category: "client", title: "Page ids", content: "290–308", projectId: "proj_uproof" }).data;
    d = createKnowledgeItem(d, human, { scope: "PROJECT", category: "client", title: "Other project", content: "n/a", projectId: "proj_other" }).data;
    d = createKnowledgeItem(d, agent08, { scope: "TASK", category: "other", title: "ctx", content: "tmp", projectId: "proj_uproof", jobId: "job_1" }).data;
    d = createKnowledgeItem(d, agent08, { scope: "TASK", category: "other", title: "ctx2", content: "tmp", projectId: "proj_uproof", jobId: "job_2" }).data;
    const inForce = knowledgeForJob(d, "proj_uproof", "job_1");
    expect(inForce.filter((k) => k.scope === "DOCTRINE").length).toBe(4);
    expect(inForce.filter((k) => k.status !== "APPROVED").length).toBe(0);
    expect(inForce.some((k) => k.title === "Page ids")).toBe(true);
    expect(inForce.some((k) => k.title === "Other project")).toBe(false);
    expect(inForce.filter((k) => k.scope === "TASK").map((k) => k.title)).toEqual(["ctx"]);
    const cleared = clearTaskKnowledge(d, "job_1");
    expect(cleared.knowledgeItems.some((k) => k.jobId === "job_1")).toBe(false);
    expect(cleared.knowledgeItems.some((k) => k.jobId === "job_2")).toBe(true);
  });
});

describe("review scope rules (review fixes)", () => {
  it("a human may narrow scope but never widen a proposal into DOCTRINE", () => {
    const d = base();
    expect(() => reviewKnowledgeItem(d, human, "kn_up_backup_before_mutation", "APPROVED", { scope: "DOCTRINE" })).toThrow(/never widen/);
  });
});

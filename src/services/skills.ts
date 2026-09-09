/**
 * Skills / instruction packs (CTOS-003 Parts I, J, K, L) — see docs/SKILL-SYSTEM.md.
 *
 * One versioned, approvable resource (`Skill`) covers both concepts the ticket describes:
 * a reusable "instruction pack" that shapes an agent's behaviour (Part I), and a reviewed
 * "skill" like the CT Visual Design Skill or CT Elementor Builder Skill (Parts J/K). Both are,
 * structurally, "an approved body of text an agent's execution context may include" — giving
 * them one DRAFT → CANDIDATE → APPROVED → DEPRECATED lifecycle (Part L) is deliberately the
 * un-over-engineered reading: one small system, not two.
 *
 * The rule this file exists to enforce structurally, not just by convention:
 *   - only a human may approve, reject or deprecate a skill (never an agent, and never the
 *     model that authored the content) — see `approveSkill`.
 *   - only APPROVED skills may ever reach a production execution context — see
 *     `approvedSkillsForAgent`, used by `services/agent-jobs.ts` when it builds a request.
 *   - editing an APPROVED skill creates a NEW version; the previous approved version keeps
 *     serving production until the new one is itself approved (never edited in place).
 */
import type { OSData, Skill, SkillKind, SkillStatus } from "@/data/types";
import { newId, nowIso } from "@/lib/core";

export const SKILL_STATUS_LABELS: Record<SkillStatus, string> = {
  DRAFT: "Draft",
  CANDIDATE: "Candidate",
  APPROVED: "Approved",
  DEPRECATED: "Deprecated",
  REJECTED: "Rejected",
};

export const SKILL_KIND_LABELS: Record<SkillKind, string> = {
  instruction_pack: "Instruction pack",
  design_review: "Design review skill",
  build_practice: "Build practice skill",
  other: "Other",
};

export class SkillPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillPolicyError";
  }
}

export type SkillActor = { kind: "human"; name: string; id: string; role: "ADMIN" | "PRODUCTION_LEAD" | "TEAM_MEMBER" | "VIEWER" } | { kind: "agent"; agentId: string };

export interface CreateSkillInput {
  name: string;
  kind: SkillKind;
  scope: string;
  ownerAgentIds: string[];
  reviewerAgentIds?: string[];
  content: string;
  evidence?: string[];
  /** DRAFT by default. Only a human review moves it to CANDIDATE/APPROVED — see reviewSkill. */
  status?: Extract<SkillStatus, "DRAFT" | "CANDIDATE">;
  id?: string;
  at?: string;
}

export function createSkill(data: OSData, input: CreateSkillInput): { data: OSData; skill: Skill } {
  const at = input.at ?? nowIso();
  const skill: Skill = {
    id: input.id ?? newId("skill"),
    name: input.name,
    version: 1,
    kind: input.kind,
    status: input.status ?? "DRAFT",
    scope: input.scope,
    ownerAgentIds: input.ownerAgentIds,
    reviewerAgentIds: input.reviewerAgentIds ?? [],
    content: input.content,
    evidence: input.evidence ?? [],
    supersedesId: null,
    approvedBy: null,
    approvedById: null,
    approvedAt: null,
    createdAt: at,
    updatedAt: at,
  };
  return { data: { ...data, skills: [...data.skills, skill] }, skill };
}

export type SkillReviewDecision = "APPROVED" | "REJECTED" | "DEPRECATED";

/**
 * Human review of a skill. Structurally impossible for an agent to call this into an APPROVED
 * outcome: the type of `reviewer` only admits `{ kind: "human" }` down the APPROVED path, and the
 * runtime check below re-asserts it (defence in depth, same pattern as knowledge.ts).
 */
export function reviewSkill(data: OSData, reviewer: SkillActor, skillId: string, decision: SkillReviewDecision, note?: string): { data: OSData; skill: Skill } {
  if (reviewer.kind !== "human") throw new SkillPolicyError("Only a human may approve, reject or deprecate a skill — never an agent or the model that authored it");
  if (reviewer.role !== "ADMIN" && reviewer.role !== "PRODUCTION_LEAD") throw new SkillPolicyError(`${reviewer.role} may not review skills (Admin or Production Lead only)`);
  const existing = data.skills.find((s) => s.id === skillId);
  if (!existing) throw new Error(`Skill ${skillId} not found`);
  if (decision === "APPROVED" && existing.status !== "CANDIDATE" && existing.status !== "DRAFT") throw new SkillPolicyError(`Only a DRAFT or CANDIDATE skill can be approved (skill is ${existing.status})`);
  if (decision === "REJECTED" && existing.status === "APPROVED") throw new SkillPolicyError("An APPROVED skill cannot be rejected — deprecate it instead");
  if (decision === "DEPRECATED" && existing.status !== "APPROVED") throw new SkillPolicyError(`Only an APPROVED skill can be deprecated (skill is ${existing.status})`);
  const at = nowIso();
  const skill: Skill = {
    ...existing,
    status: decision,
    approvedBy: decision === "APPROVED" ? reviewer.name : existing.approvedBy,
    approvedById: decision === "APPROVED" ? reviewer.id : existing.approvedById,
    approvedAt: decision === "APPROVED" ? at : existing.approvedAt,
    updatedAt: at,
  };
  void note;
  return { data: { ...data, skills: data.skills.map((s) => (s.id === skillId ? skill : s)) }, skill };
}

/**
 * Edit an APPROVED skill: never in place. Creates version + 1 as a new DRAFT row, linked by
 * `supersedesId`; the existing APPROVED row is untouched and keeps serving production until the
 * new version is itself approved (Part L: "the previous approved version remains historically
 * available"). Editing a DRAFT/CANDIDATE (not yet approved) skill is a normal in-place update —
 * only an APPROVED skill's content is protected this way.
 */
export function reviseSkill(data: OSData, skillId: string, patch: Pick<Skill, "content" | "evidence"> & Partial<Pick<Skill, "name" | "scope" | "ownerAgentIds" | "reviewerAgentIds">>): { data: OSData; skill: Skill } {
  const existing = data.skills.find((s) => s.id === skillId);
  if (!existing) throw new Error(`Skill ${skillId} not found`);
  const at = nowIso();
  if (existing.status !== "APPROVED") {
    const skill: Skill = { ...existing, ...patch, updatedAt: at };
    return { data: { ...data, skills: data.skills.map((s) => (s.id === skillId ? skill : s)) }, skill };
  }
  const next: Skill = {
    ...existing,
    ...patch,
    id: newId("skill"),
    version: existing.version + 1,
    status: "DRAFT",
    supersedesId: existing.id,
    approvedBy: null,
    approvedById: null,
    approvedAt: null,
    createdAt: at,
    updatedAt: at,
  };
  return { data: { ...data, skills: [...data.skills, next] }, skill: next };
}

/** True production-execution gate: only ever true for APPROVED skills. */
export function isProductionReady(skill: Skill): boolean {
  return skill.status === "APPROVED";
}

export interface ActiveSkillRef {
  id: string;
  name: string;
  version: number;
  kind: SkillKind;
  content: string;
}

/**
 * APPROVED skills relevant to one agent: skills it owns or reviews, plus any of its explicit
 * `instructionPackIds`. CANDIDATE/DRAFT/DEPRECATED skills are never included — this is the
 * function `buildExecutionRequest` calls, so it is also the enforcement point for "unapproved
 * skills excluded from production context" (CTOS-003 Part O).
 */
export function approvedSkillsForAgent(data: OSData, agentId: string, instructionPackIds: string[] = []): ActiveSkillRef[] {
  const relevant = data.skills.filter((s) => isProductionReady(s) && (s.ownerAgentIds.includes(agentId) || s.reviewerAgentIds.includes(agentId) || instructionPackIds.includes(s.id)));
  return relevant.map((s) => ({ id: s.id, name: s.name, version: s.version, kind: s.kind, content: s.content }));
}

/** "id@version" provenance strings for runs/execution logs (Part L: "execution records which skill version was used"). */
export function skillProvenance(skills: ActiveSkillRef[]): string[] {
  return skills.map((s) => `${s.id}@${s.version}`);
}

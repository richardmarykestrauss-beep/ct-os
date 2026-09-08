/**
 * Job approvals (AMBER) and authorizations (RED).
 *
 * These records are what the execution gateway checks server-side before a provider is called.
 * They are tied to a specific job AND an action fingerprint, so an approval cannot be reused for
 * a different instruction set. Pure functions over OSData, shared by the store, the embedded
 * gateway and the tests.
 */
import type { AgentJob, AuthUser, JobApproval, JobApprovalKind, OSData, PermissionLevel, UserRole } from "@/data/types";
import { newId, nowIso } from "@/lib/core";
import { sha256Hex } from "@/lib/hash";

export const APPROVER_ROLES: UserRole[] = ["ADMIN", "PRODUCTION_LEAD"];
export const EXECUTOR_ROLES: UserRole[] = ["ADMIN", "PRODUCTION_LEAD", "TEAM_MEMBER"];

export type FingerprintFields = Pick<AgentJob, "projectId" | "agentId" | "taskType" | "instructions" | "requiredOutputSchema" | "inputArtifactIds" | "availableToolIds" | "preferredProvider" | "fallbackProviders">;

/**
 * SHA-256 over everything that defines the action: project, agent, task, instructions, output
 * schema, input artifacts, tools and provider policy. Change any of them and the approval is void.
 */
export function actionFingerprint(job: FingerprintFields): string {
  const canonical = JSON.stringify([job.projectId, job.agentId, job.taskType, job.requiredOutputSchema, job.instructions, [...job.inputArtifactIds], [...job.availableToolIds], job.preferredProvider, [...job.fallbackProviders]]);
  return `fp_${sha256Hex(canonical)}`;
}

export function kindForLevel(level: PermissionLevel): JobApprovalKind | null {
  return level === "AMBER" ? "APPROVAL" : level === "RED" ? "AUTHORIZATION" : null;
}

export function describeAction(job: AgentJob, agentName: string): string {
  return `${agentName}: ${job.taskType.replace(/_/g, " ")} → ${job.requiredOutputSchema}`;
}

/** Request approval for an AMBER job (any executor may request). Idempotent per job while PENDING. */
export function requestJobApproval(data: OSData, job: AgentJob, actor: AuthUser, agentName: string, opts: { id?: string; at?: string } = {}): { data: OSData; approval: JobApproval; created: boolean } {
  const fp = actionFingerprint(job);
  const existing = data.jobApprovals.find((a) => a.jobId === job.id && a.kind === "APPROVAL" && a.actionFingerprint === fp && (a.status === "PENDING" || a.status === "APPROVED"));
  if (existing) return { data, approval: existing, created: false };
  const at = opts.at ?? nowIso();
  const approval: JobApproval = {
    id: opts.id ?? newId("jappr"),
    jobId: job.id,
    projectId: job.projectId,
    agentId: job.agentId,
    kind: "APPROVAL",
    permissionLevel: "AMBER",
    actionFingerprint: fp,
    requestedAction: describeAction(job, agentName),
    requestedById: actor.id,
    requestedByName: actor.displayName,
    approvedById: null,
    approvedByName: null,
    approvedByRole: null,
    status: "PENDING",
    createdAt: at,
    decidedAt: null,
    consumedAt: null,
    expiresAt: null,
  };
  return { data: { ...data, jobApprovals: [...data.jobApprovals, approval] }, approval, created: true };
}

export class ApprovalPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalPolicyError";
  }
}

/** A lead/admin decides a pending AMBER approval. */
export function decideJobApproval(data: OSData, approvalId: string, decision: "APPROVED" | "REJECTED", actor: AuthUser, note?: string): { data: OSData; approval: JobApproval } {
  if (!APPROVER_ROLES.includes(actor.role)) throw new ApprovalPolicyError(`Role ${actor.role} cannot approve AMBER jobs`);
  const existing = data.jobApprovals.find((a) => a.id === approvalId);
  if (!existing) throw new Error(`Job approval ${approvalId} not found`);
  if (existing.status !== "PENDING") throw new ApprovalPolicyError(`Approval is ${existing.status}, not PENDING`);
  if (existing.kind !== "APPROVAL") throw new ApprovalPolicyError("Authorizations are self-issued by the executor, not decided by a reviewer");
  const at = nowIso();
  const approval: JobApproval = { ...existing, status: decision, approvedById: actor.id, approvedByName: actor.displayName, approvedByRole: actor.role, decidedAt: at, note: note ?? existing.note };
  return { data: { ...data, jobApprovals: data.jobApprovals.map((a) => (a.id === approvalId ? approval : a)) }, approval };
}

/** RED: the executor explicitly authorizes THIS job/action for themselves. Lead/admin only. */
export function authorizeRedJob(data: OSData, job: AgentJob, actor: AuthUser, agentName: string, opts: { id?: string; at?: string; note?: string } = {}): { data: OSData; approval: JobApproval } {
  if (!APPROVER_ROLES.includes(actor.role)) throw new ApprovalPolicyError(`Role ${actor.role} cannot authorize RED actions`);
  const at = opts.at ?? nowIso();
  const approval: JobApproval = {
    id: opts.id ?? newId("jauth"),
    jobId: job.id,
    projectId: job.projectId,
    agentId: job.agentId,
    kind: "AUTHORIZATION",
    permissionLevel: "RED",
    actionFingerprint: actionFingerprint(job),
    requestedAction: describeAction(job, agentName),
    requestedById: actor.id,
    requestedByName: actor.displayName,
    approvedById: actor.id,
    approvedByName: actor.displayName,
    approvedByRole: actor.role,
    status: "APPROVED",
    note: opts.note,
    createdAt: at,
    decidedAt: at,
    consumedAt: null,
    expiresAt: null,
  };
  return { data: { ...data, jobApprovals: [...data.jobApprovals, approval] }, approval };
}

export interface PermissionCheck {
  level: PermissionLevel;
  outcome: "allowed" | "denied";
  reason: string;
  approvalId: string | null;
}

/** Effective tier: the higher of the job's recorded tier and the agent's current tier. */
export function effectiveLevel(jobLevel: PermissionLevel, agentLevel: PermissionLevel): PermissionLevel {
  const rank: Record<PermissionLevel, number> = { GREEN: 0, AMBER: 1, RED: 2 };
  return rank[agentLevel] > rank[jobLevel] ? agentLevel : jobLevel;
}

/**
 * The permission decision the gateway enforces. Pure so it can be tested exhaustively.
 * `approverRole` lets the caller re-verify the approver's role from profiles (server) — when
 * absent, the role recorded on the approval is used.
 */
export function checkPermission(input: { level: PermissionLevel; user: AuthUser; job: AgentJob; approvals: JobApproval[]; approverRole?: (userId: string) => UserRole | null; now?: string }): PermissionCheck {
  const { level, user, job, approvals } = input;
  const now = input.now ?? nowIso();
  if (!EXECUTOR_ROLES.includes(user.role)) return { level, outcome: "denied", reason: `Role ${user.role} cannot execute jobs`, approvalId: null };
  if (level === "GREEN") return { level, outcome: "allowed", reason: "GREEN — automatic", approvalId: null };
  const fp = actionFingerprint(job);
  const live = approvals.filter((a) => a.jobId === job.id && a.status === "APPROVED" && (!a.expiresAt || a.expiresAt > now));
  if (level === "AMBER") {
    const match = live.find((a) => a.kind === "APPROVAL" && a.actionFingerprint === fp);
    if (!match) return { level, outcome: "denied", reason: approvals.some((a) => a.jobId === job.id && a.kind === "APPROVAL" && a.actionFingerprint !== fp && a.status === "APPROVED") ? "AMBER — approval exists but the action changed since it was approved" : "AMBER — no approval record for this job", approvalId: null };
    // When a role lookup exists (server: profiles), it is the only source of truth — the record's own role is never trusted.
    const role = match.approvedById ? (input.approverRole ? input.approverRole(match.approvedById) : match.approvedByRole) : null;
    if (!match.approvedById || !role || !APPROVER_ROLES.includes(role)) return { level, outcome: "denied", reason: "AMBER — approver is not a Production Lead or Admin", approvalId: match.id };
    return { level, outcome: "allowed", reason: `AMBER — approved by ${match.approvedByName ?? match.approvedById}`, approvalId: match.id };
  }
  // RED
  const match = live.find((a) => a.kind === "AUTHORIZATION" && a.actionFingerprint === fp && a.approvedById === user.id);
  if (!match) return { level, outcome: "denied", reason: "RED — no explicit authorization by the current user for this exact action", approvalId: null };
  const role = input.approverRole?.(user.id) ?? user.role;
  if (!APPROVER_ROLES.includes(role)) return { level, outcome: "denied", reason: `RED — role ${role} cannot authorize`, approvalId: match.id };
  return { level, outcome: "allowed", reason: `RED — authorized by ${user.displayName}`, approvalId: match.id };
}

export function consumeApproval(data: OSData, approvalId: string | null, at = nowIso()): OSData {
  if (!approvalId) return data;
  return { ...data, jobApprovals: data.jobApprovals.map((a) => (a.id === approvalId && a.status === "APPROVED" ? { ...a, status: "CONSUMED", consumedAt: at } : a)) };
}

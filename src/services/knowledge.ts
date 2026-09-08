/**
 * Intelligence / memory model.
 *
 * Four scopes: DOCTRINE (permanent rules) · AGENCY (validated patterns) · PROJECT (client facts)
 * · TASK (temporary execution context). Agents may PROPOSE. Only a human may APPROVE, REJECT or
 * DEPRECATE. There is no code path by which an agent promotes its own output into AGENCY or
 * DOCTRINE knowledge — the functions below enforce that structurally.
 */
import type { AgentLesson, KnowledgeCategory, KnowledgeItem, KnowledgeScope, KnowledgeStatus, OSData } from "@/data/types";
import { newId, nowIso } from "@/lib/core";

export const KNOWLEDGE_SCOPES: { scope: KnowledgeScope; label: string; description: string }[] = [
  { scope: "DOCTRINE", label: "Doctrine", description: "Permanent Creative Touch rules. Human-authored only." },
  { scope: "AGENCY", label: "Agency", description: "Validated Creative Touch knowledge and patterns. Enters only by human approval." },
  { scope: "PROJECT", label: "Project", description: "Client/project-specific facts and decisions." },
  { scope: "TASK", label: "Task", description: "Temporary execution context bound to one job." },
];

export const KNOWLEDGE_SCOPE_LABELS: Record<KnowledgeScope, string> = { DOCTRINE: "Doctrine", AGENCY: "Agency", PROJECT: "Project", TASK: "Task" };

export type Actor = { kind: "human"; name: string; id?: string | null } | { kind: "agent"; agentId: string };

export class KnowledgePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgePolicyError";
  }
}

export interface ProposeLessonInput {
  agentId: string;
  projectId: string | null;
  title: string;
  content: string;
  category: KnowledgeCategory;
  evidence: string[];
  /** Agents may ask for AGENCY or PROJECT scope. Never DOCTRINE. */
  proposedScope: "AGENCY" | "PROJECT";
  confidence?: number;
  sourceArtifactId?: string | null;
  sourceJobId?: string | null;
  source?: string;
  id?: string;
  at?: string;
}

/**
 * An agent proposes a lesson. The result is ALWAYS a CANDIDATE knowledge item plus a ledger
 * entry — regardless of what the caller asks for.
 */
export function proposeLesson(data: OSData, input: ProposeLessonInput): { data: OSData; item: KnowledgeItem; lesson: AgentLesson } {
  if (input.proposedScope === "PROJECT" && !input.projectId) throw new KnowledgePolicyError("PROJECT-scope lessons need a projectId");
  const at = input.at ?? nowIso();
  const item: KnowledgeItem = {
    id: input.id ?? newId("kn"),
    scope: input.proposedScope,
    category: input.category,
    title: input.title,
    content: input.content,
    evidence: input.evidence,
    confidence: clamp01(input.confidence ?? 0.5),
    status: "CANDIDATE",
    projectId: input.proposedScope === "PROJECT" ? input.projectId : null,
    jobId: null,
    proposedByAgentId: input.agentId,
    reviewedBy: null,
    reviewedById: null,
    reviewedAt: null,
    createdAt: at,
    updatedAt: at,
  };
  const lesson: AgentLesson = {
    id: newId("lesson"),
    projectId: input.projectId,
    agentId: input.agentId,
    knowledgeItemId: item.id,
    proposedScope: input.proposedScope,
    sourceArtifactId: input.sourceArtifactId ?? null,
    sourceJobId: input.sourceJobId ?? null,
    source: input.source ?? `Proposed by ${input.agentId}`,
    status: "CANDIDATE",
    reviewedBy: null,
    reviewedById: null,
    reviewedAt: null,
    createdAt: at,
  };
  return { data: { ...data, knowledgeItems: [...data.knowledgeItems, item], agentLessons: [...data.agentLessons, lesson] }, item, lesson };
}

export interface CreateKnowledgeInput {
  scope: KnowledgeScope;
  category: KnowledgeCategory;
  title: string;
  content: string;
  evidence?: string[];
  confidence?: number;
  projectId?: string | null;
  jobId?: string | null;
  id?: string;
  at?: string;
}

/**
 * Direct knowledge creation.
 *  - Humans may create in any scope; DOCTRINE/AGENCY/PROJECT land as APPROVED.
 *  - Agents may create TASK-scope context (bound to a job) as APPROVED, and PROJECT/AGENCY only as CANDIDATE.
 *  - Nobody but a human may write DOCTRINE.
 */
export function createKnowledgeItem(data: OSData, actor: Actor, input: CreateKnowledgeInput): { data: OSData; item: KnowledgeItem } {
  if (input.scope === "DOCTRINE" && actor.kind !== "human") throw new KnowledgePolicyError("Only a human may write DOCTRINE knowledge");
  if ((input.scope === "PROJECT" || input.scope === "TASK") && !input.projectId) throw new KnowledgePolicyError(`${input.scope}-scope knowledge needs a projectId`);
  if (input.scope === "TASK" && !input.jobId) throw new KnowledgePolicyError("TASK-scope knowledge needs a jobId");
  const at = input.at ?? nowIso();
  const status: KnowledgeStatus = actor.kind === "human" || input.scope === "TASK" ? "APPROVED" : "CANDIDATE";
  const item: KnowledgeItem = {
    id: input.id ?? newId("kn"),
    scope: input.scope,
    category: input.category,
    title: input.title,
    content: input.content,
    evidence: input.evidence ?? [],
    confidence: clamp01(input.confidence ?? (actor.kind === "human" ? 0.9 : 0.5)),
    status,
    projectId: input.scope === "DOCTRINE" || input.scope === "AGENCY" ? null : (input.projectId ?? null),
    jobId: input.scope === "TASK" ? (input.jobId ?? null) : null,
    proposedByAgentId: actor.kind === "agent" ? actor.agentId : null,
    reviewedBy: actor.kind === "human" && status === "APPROVED" ? actor.name : null,
    reviewedById: actor.kind === "human" && status === "APPROVED" ? (actor.id ?? null) : null,
    reviewedAt: actor.kind === "human" && status === "APPROVED" ? at : null,
    createdAt: at,
    updatedAt: at,
  };
  return { data: { ...data, knowledgeItems: [...data.knowledgeItems, item] }, item };
}

export type ReviewDecision = "APPROVED" | "REJECTED" | "DEPRECATED";

/**
 * Human review of a knowledge item. Agents are rejected at the type level AND at runtime.
 * Approving may narrow scope (e.g. an AGENCY proposal approved as PROJECT knowledge).
 */
export function reviewKnowledgeItem(
  data: OSData,
  reviewer: Actor,
  itemId: string,
  decision: ReviewDecision,
  opts: { scope?: Exclude<KnowledgeScope, "TASK">; projectId?: string | null; note?: string } = {},
): { data: OSData; item: KnowledgeItem } {
  if (reviewer.kind !== "human") throw new KnowledgePolicyError("Only a human may approve, reject or deprecate knowledge");
  const existing = data.knowledgeItems.find((k) => k.id === itemId);
  if (!existing) throw new Error(`Knowledge item ${itemId} not found`);
  if (decision === "APPROVED" && existing.status !== "CANDIDATE") throw new KnowledgePolicyError(`Only CANDIDATE items can be approved (item is ${existing.status})`);
  if (decision === "DEPRECATED" && existing.status !== "APPROVED") throw new KnowledgePolicyError(`Only APPROVED items can be deprecated (item is ${existing.status})`);
  if (decision === "REJECTED" && existing.status !== "CANDIDATE") throw new KnowledgePolicyError(`Only CANDIDATE items can be rejected (item is ${existing.status})`);
  const scope = opts.scope ?? existing.scope;
  if (scope === "DOCTRINE" && existing.scope !== "DOCTRINE") throw new KnowledgePolicyError("Review may narrow scope, never widen it to DOCTRINE — doctrine is authored directly by a human");
  if (scope === "PROJECT" && !(opts.projectId ?? existing.projectId)) throw new KnowledgePolicyError("PROJECT-scope approval needs a projectId");
  const at = nowIso();
  const item: KnowledgeItem = {
    ...existing,
    scope,
    projectId: scope === "PROJECT" || scope === "TASK" ? (opts.projectId ?? existing.projectId) : null,
    status: decision,
    reviewedBy: reviewer.name,
    reviewedById: reviewer.id ?? null,
    reviewedAt: at,
    updatedAt: at,
  };
  const agentLessons = data.agentLessons.map((l) =>
    l.knowledgeItemId === itemId && l.status === "CANDIDATE" && decision !== "DEPRECATED" ? { ...l, status: decision, reviewedBy: reviewer.name, reviewedById: reviewer.id ?? null, reviewedAt: at } : l,
  );
  return { data: { ...data, knowledgeItems: data.knowledgeItems.map((k) => (k.id === itemId ? item : k)), agentLessons }, item };
}

/** Approved knowledge an agent job should see: doctrine + agency + this project's facts + this job's task context. */
export function knowledgeForJob(data: OSData, projectId: string, jobId?: string | null): KnowledgeItem[] {
  return data.knowledgeItems.filter((k) => {
    if (k.status !== "APPROVED") return false;
    switch (k.scope) {
      case "DOCTRINE":
      case "AGENCY":
        return true;
      case "PROJECT":
        return k.projectId === projectId;
      case "TASK":
        return !!jobId && k.jobId === jobId;
    }
  });
}

/** Drop TASK-scope context once its job is finished. */
export function clearTaskKnowledge(data: OSData, jobId: string): OSData {
  return { ...data, knowledgeItems: data.knowledgeItems.filter((k) => !(k.scope === "TASK" && k.jobId === jobId)) };
}

export function candidateCount(data: OSData): number {
  return data.knowledgeItems.filter((k) => k.status === "CANDIDATE").length;
}

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

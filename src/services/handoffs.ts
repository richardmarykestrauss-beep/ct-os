/**
 * Agent handoffs.
 *
 * Agent A produces an artifact; Agent B consumes it. The handoff record is the only
 * sanctioned channel between agents — there is no agent-to-agent conversation.
 */
import type { AgentCode, ArtifactType, Handoff, HandoffStatus, OSData } from "@/data/types";
import { newId, nowIso } from "@/lib/core";

/** The standard production chain. Each step names the artifact the next agent consumes. */
export const HANDOFF_CHAIN: { from: AgentCode; artifact: ArtifactType; to: AgentCode }[] = [
  { from: "A01", artifact: "research_report", to: "A02" },
  { from: "A02", artifact: "site_blueprint", to: "A03" },
  { from: "A03", artifact: "design_system", to: "A04" },
  { from: "A04", artifact: "content_pack", to: "A05" },
  { from: "A05", artifact: "build_report", to: "A06" },
  { from: "A06", artifact: "qa_report", to: "A07" },
  { from: "A07", artifact: "deployment_report", to: "A08" },
  { from: "A08", artifact: "lesson_candidate", to: "ORCH" },
];

/** Which agent code normally consumes an artifact type next. */
export function nextAgentFor(artifact: ArtifactType): AgentCode | null {
  return HANDOFF_CHAIN.find((s) => s.artifact === artifact)?.to ?? null;
}

const HANDOFF_TRANSITIONS: Record<HandoffStatus, HandoffStatus[]> = {
  PENDING: ["ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "REJECTED", "CANCELLED"],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function canTransitionHandoff(from: HandoffStatus, to: HandoffStatus) {
  return HANDOFF_TRANSITIONS[from].includes(to);
}

export interface CreateHandoffInput {
  projectId: string;
  sourceAgentId: string;
  destinationAgentId: string;
  inputArtifactIds: string[];
  jobId?: string | null;
  note?: string;
  status?: HandoffStatus;
  id?: string;
  at?: string;
}

export function createHandoff(data: OSData, input: CreateHandoffInput): { data: OSData; handoff: Handoff } {
  if (input.sourceAgentId === input.destinationAgentId) throw new Error("A handoff needs two different agents");
  for (const id of input.inputArtifactIds) {
    const a = data.artifacts.find((x) => x.id === id);
    if (!a) throw new Error(`Input artifact ${id} not found`);
    if (a.projectId !== input.projectId) throw new Error(`Artifact ${id} belongs to another project`);
  }
  const at = input.at ?? nowIso();
  const handoff: Handoff = {
    id: input.id ?? newId("handoff"),
    projectId: input.projectId,
    sourceAgentId: input.sourceAgentId,
    destinationAgentId: input.destinationAgentId,
    inputArtifactIds: input.inputArtifactIds,
    outputArtifactId: null,
    jobId: input.jobId ?? null,
    runId: null,
    status: input.status ?? "PENDING",
    note: input.note,
    createdAt: at,
    updatedAt: at,
  };
  return { data: { ...data, handoffs: [...data.handoffs, handoff] }, handoff };
}

export function transitionHandoff(data: OSData, handoffId: string, to: HandoffStatus, patch: Partial<Pick<Handoff, "outputArtifactId" | "runId" | "jobId" | "note">> = {}): { data: OSData; handoff: Handoff } {
  const existing = data.handoffs.find((h) => h.id === handoffId);
  if (!existing) throw new Error(`Handoff ${handoffId} not found`);
  if (!canTransitionHandoff(existing.status, to)) throw new Error(`Handoff ${handoffId}: ${existing.status} → ${to} is not allowed`);
  if (to === "COMPLETED" && !(patch.outputArtifactId ?? existing.outputArtifactId)) throw new Error("A handoff completes only with an output artifact");
  const handoff: Handoff = { ...existing, ...patch, status: to, updatedAt: nowIso() };
  return { data: { ...data, handoffs: data.handoffs.map((h) => (h.id === handoffId ? handoff : h)) }, handoff };
}

/**
 * Curation service — Agent 08 (CTOS-005A Part 26).
 *
 * Agent 08 is event-triggered and NEVER auto-promotes.
 * It proposes a destination for curated lessons; a human must explicitly approve.
 * Evidence references are required — no evidence, no curation.
 */
import type {
  CurationCandidate,
  CurationDestinationProposal,
  KnowledgeCategory,
  KnowledgeItem,
  KnowledgeScope,
  OSData,
} from "@/data/types";
import { newId, nowIso } from "@/lib/core";

// ---------------------------------------------------------------------------
// Candidate creation (Agent 08 proposes; human decides)
// ---------------------------------------------------------------------------

/**
 * Create a curation candidate from a completed job.
 * Requires at least one evidence reference — jobs without evidence cannot generate candidates.
 * Status begins as PENDING until a human explicitly promotes, rejects, or defers it.
 */
export function proposeCurationCandidate(
  data: OSData,
  opts: {
    agentId: string;
    projectId: string | null;
    title: string;
    content: string;
    evidenceRefs: string[];
    proposedScope: Exclude<KnowledgeScope, "TASK">;
    confidence: number;
    destinationProposal: CurationDestinationProposal;
    observedProjectCount?: number;
  },
): { data: OSData; candidate: CurationCandidate } {
  if (opts.evidenceRefs.length === 0) {
    throw new Error(
      `Curation candidate from agent ${opts.agentId} requires at least one evidence reference. No evidence, no curation.`,
    );
  }

  const candidate: CurationCandidate = {
    id: newId("cc"),
    projectId: opts.projectId,
    agentId: opts.agentId,
    title: opts.title,
    content: opts.content,
    evidenceRefs: opts.evidenceRefs,
    proposedScope: opts.proposedScope,
    observedProjectCount: opts.observedProjectCount ?? 1,
    confidence: opts.confidence,
    destinationProposal: opts.destinationProposal,
    status: "PENDING",
    reviewedById: null,
    reviewedByName: null,
    reviewedAt: null,
    createdAt: nowIso(),
  };

  return {
    data: { ...data, curationCandidates: [...data.curationCandidates, candidate] },
    candidate,
  };
}

// ---------------------------------------------------------------------------
// Human approval gate
// ---------------------------------------------------------------------------

/**
 * Promote a curation candidate to a KnowledgeItem.
 * DOCTRINE scope requires the human to confirm twice (enforced via confirmed=true).
 */
export function promoteCurationCandidate(
  data: OSData,
  candidateId: string,
  opts: {
    reviewedById: string;
    reviewedByName: string;
    chosenScope: KnowledgeScope;
    category: KnowledgeCategory;
    confirmed: boolean;
  },
): { data: OSData; knowledgeItem: KnowledgeItem } {
  if (opts.chosenScope === "DOCTRINE" && !opts.confirmed) {
    throw new Error("Promoting a lesson to DOCTRINE scope requires explicit confirmation (confirmed=true).");
  }

  const candidate = data.curationCandidates.find((c) => c.id === candidateId);
  if (!candidate) throw new Error(`Curation candidate ${candidateId} not found`);
  if (candidate.status !== "PENDING") {
    throw new Error(`Curation candidate ${candidateId} is already ${candidate.status}`);
  }

  const at = nowIso();
  const knowledgeItem: KnowledgeItem = {
    id: newId("ki"),
    scope: opts.chosenScope,
    category: opts.category,
    title: candidate.title,
    content: candidate.content,
    evidence: candidate.evidenceRefs,
    confidence: candidate.confidence,
    status: "APPROVED",
    projectId: opts.chosenScope === "PROJECT" || opts.chosenScope === "TASK" ? (candidate.projectId ?? null) : null,
    jobId: null,
    proposedByAgentId: candidate.agentId,
    reviewedBy: opts.reviewedByName,
    reviewedById: opts.reviewedById,
    reviewedAt: at,
    createdAt: at,
    updatedAt: at,
  };

  const updatedCandidate: CurationCandidate = {
    ...candidate,
    status: "PROMOTED",
    reviewedById: opts.reviewedById,
    reviewedByName: opts.reviewedByName,
    reviewedAt: at,
  };

  return {
    data: {
      ...data,
      knowledgeItems: [...data.knowledgeItems, knowledgeItem],
      curationCandidates: data.curationCandidates.map((c) => (c.id === candidateId ? updatedCandidate : c)),
    },
    knowledgeItem,
  };
}

/** Reject a curation candidate (human decision). */
export function rejectCurationCandidate(
  data: OSData,
  candidateId: string,
  reviewedById: string,
  reviewedByName: string,
): OSData {
  return {
    ...data,
    curationCandidates: data.curationCandidates.map((c) =>
      c.id === candidateId
        ? { ...c, status: "REJECTED" as const, reviewedById, reviewedByName, reviewedAt: nowIso() }
        : c,
    ),
  };
}

/** Defer a curation candidate for later review. */
export function deferCurationCandidate(data: OSData, candidateId: string): OSData {
  return {
    ...data,
    curationCandidates: data.curationCandidates.map((c) =>
      c.id === candidateId ? { ...c, status: "DEFERRED" as const } : c,
    ),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get all PENDING candidates awaiting review for a project. */
export function pendingCurationCandidates(data: OSData, projectId: string): CurationCandidate[] {
  return data.curationCandidates.filter((c) => c.projectId === projectId && c.status === "PENDING");
}

/** Build a destination proposal. */
export function buildDestinationProposal(
  type: CurationDestinationProposal["type"],
  targetId: string | null,
  reason: string,
): CurationDestinationProposal {
  return { type, targetId, reason };
}

/**
 * Revision control service (CTOS-005A Part 19).
 *
 * Tracks revision rounds for client-facing projects.
 * Each round is linked to the project state machine (CLIENT_REVIEW → READY_TO_BUILD).
 */
import type {
  ChangeRequest,
  ChangeRequestClassification,
  OSData,
  RevisionRound,
} from "@/data/types";
import { newId, nowIso } from "@/lib/core";

// ---------------------------------------------------------------------------
// Revision round lifecycle
// ---------------------------------------------------------------------------

/** Open a new revision round when the project enters CLIENT_REVIEW. */
export function openRevisionRound(
  data: OSData,
  projectId: string,
  roundNumber: number,
  requestSource: RevisionRound["requestSource"],
): { data: OSData; revisionRound: RevisionRound } {
  const round: RevisionRound = {
    id: newId("rr"),
    projectId,
    roundNumber,
    requestSource,
    ticketIds: [],
    changeRequestIds: [],
    scopeClassification: null,
    approvedByLeadId: null,
    approvedByLeadName: null,
    approvedAt: null,
    completedAt: null,
    createdAt: nowIso(),
  };
  return { data: { ...data, revisionRounds: [...data.revisionRounds, round] }, revisionRound: round };
}

/** Add a change request to an open revision round. */
export function addChangeRequest(
  data: OSData,
  roundId: string,
  opts: {
    title: string;
    description: string;
    classification: ChangeRequestClassification;
    recommendedByAgentId: string | null;
    ticketIds?: string[];
  },
): { data: OSData; changeRequest: ChangeRequest } {
  const round = data.revisionRounds.find((r) => r.id === roundId);
  if (!round) throw new Error(`Revision round ${roundId} not found`);
  if (round.completedAt !== null) throw new Error(`Revision round ${roundId} is already completed`);

  const cr: ChangeRequest = {
    id: newId("cr"),
    revisionRoundId: roundId,
    projectId: round.projectId,
    title: opts.title,
    description: opts.description,
    classification: opts.classification,
    recommendedByAgentId: opts.recommendedByAgentId,
    classifiedByLeadId: null,
    classifiedByLeadName: null,
    confirmedAt: null,
    ticketIds: opts.ticketIds ?? [],
    createdAt: nowIso(),
  };

  const updatedRound: RevisionRound = {
    ...round,
    changeRequestIds: [...round.changeRequestIds, cr.id],
    scopeClassification: round.scopeClassification ?? opts.classification,
  };

  return {
    data: {
      ...data,
      changeRequests: [...data.changeRequests, cr],
      revisionRounds: data.revisionRounds.map((r) => (r.id === roundId ? updatedRound : r)),
    },
    changeRequest: cr,
  };
}

/** Approve a revision round (lead confirms scope and authorises the work). */
export function approveRevisionRound(
  data: OSData,
  roundId: string,
  leadId: string,
  leadName: string,
): OSData {
  return {
    ...data,
    revisionRounds: data.revisionRounds.map((r) =>
      r.id === roundId
        ? { ...r, approvedByLeadId: leadId, approvedByLeadName: leadName, approvedAt: nowIso() }
        : r,
    ),
  };
}

/** Mark a revision round as completed. */
export function completeRevisionRound(data: OSData, roundId: string): OSData {
  return {
    ...data,
    revisionRounds: data.revisionRounds.map((r) =>
      r.id === roundId ? { ...r, completedAt: nowIso() } : r,
    ),
  };
}

/** Confirm a change request has been classified by the lead. */
export function confirmChangeRequest(
  data: OSData,
  changeRequestId: string,
  leadId: string,
  leadName: string,
): OSData {
  return {
    ...data,
    changeRequests: data.changeRequests.map((cr) =>
      cr.id === changeRequestId
        ? { ...cr, classifiedByLeadId: leadId, classifiedByLeadName: leadName, confirmedAt: nowIso() }
        : cr,
    ),
  };
}

/** Get all unconfirmed change requests for a project. */
export function unconfirmedChangeRequests(data: OSData, projectId: string): ChangeRequest[] {
  return data.changeRequests.filter((cr) => cr.projectId === projectId && cr.confirmedAt === null);
}

/** Current open revision round for a project (not yet completed). */
export function currentRevisionRound(data: OSData, projectId: string): RevisionRound | null {
  return (
    data.revisionRounds
      .filter((r) => r.projectId === projectId && r.completedAt === null)
      .sort((a, b) => b.roundNumber - a.roundNumber)[0] ?? null
  );
}

/**
 * Conductor boundary policy (CTOS-005A Part 4 / CTOS-005A Item 4).
 *
 * Agent 00 (ORCH) is a bounded Conductor — it orchestrates but does NOT exercise authority.
 * This module defines the executable policy for what the Conductor may and may not do.
 *
 * The boundary exists in code, not just in prompts.
 * Every gate check returns a typed decision with an audit reason.
 */
import type { AgentCode, KnowledgeScope, OSData, PermissionLevel, ProjectState } from "@/data/types";

// ---------------------------------------------------------------------------
// Conductor identity
// ---------------------------------------------------------------------------

export const CONDUCTOR_AGENT_CODE: AgentCode = "ORCH";

// ---------------------------------------------------------------------------
// What the Conductor MAY do
// ---------------------------------------------------------------------------

export const CONDUCTOR_PERMITTED = [
  "route work to specialist agents",
  "assemble build packs from approved artifacts",
  "summarize project context for human dashboards",
  "validate artifact schemas (read-only)",
  "trigger GREEN-level jobs",
  "recommend escalation to human operator",
  "compose attention queue items",
  "advance project state machine when all gates are satisfied",
] as const;

// ---------------------------------------------------------------------------
// What the Conductor MAY NOT do
// ---------------------------------------------------------------------------

export const CONDUCTOR_PROHIBITED = [
  "approve gates",
  "perform AMBER actions",
  "perform RED actions",
  "promote knowledge to DOCTRINE",
  "promote knowledge to AGENCY",
  "change skill status",
  "decide client scope",
  "decide launch approval",
  "self-certify QA results",
  "create artifacts without a job",
] as const;

export type ConductorProhibitedAction = (typeof CONDUCTOR_PROHIBITED)[number];

// ---------------------------------------------------------------------------
// Policy check functions
// ---------------------------------------------------------------------------

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

/** Reject any attempt by Conductor to approve a gate. */
export function conductorCanApproveGate(_gateId: string): PolicyDecision {
  return { allowed: false, reason: "Conductor cannot approve gates; a human operator must act." };
}

/** Reject any attempt by Conductor to perform an AMBER or RED action. */
export function conductorCanPerformAction(permissionLevel: PermissionLevel): PolicyDecision {
  if (permissionLevel === "GREEN") return { allowed: true, reason: "GREEN actions are within Conductor authority." };
  return { allowed: false, reason: `Conductor cannot perform ${permissionLevel} actions; requires human operator.` };
}

/** Reject any attempt by Conductor to promote knowledge to DOCTRINE or AGENCY. */
export function conductorCanPromoteKnowledge(scope: KnowledgeScope): PolicyDecision {
  if (scope === "PROJECT" || scope === "TASK") {
    return { allowed: false, reason: "Conductor cannot promote lessons even to PROJECT scope; curation requires human review (Agent 08 proposes, human approves)." };
  }
  return { allowed: false, reason: `Conductor cannot promote knowledge to ${scope}; only humans can approve curation.` };
}

/** Reject any attempt by Conductor to change a skill's approval status. */
export function conductorCanChangeSkillStatus(): PolicyDecision {
  return { allowed: false, reason: "Conductor cannot change skill status; a human operator must approve or deprecate skills." };
}

/** Reject any attempt by Conductor to decide client scope (in-scope vs out-of-scope). */
export function conductorCanDecideClientScope(): PolicyDecision {
  return { allowed: false, reason: "Conductor cannot decide change request scope; the project lead must classify and confirm." };
}

/** Reject any attempt by Conductor to approve launch. */
export function conductorCanApproveLaunch(): PolicyDecision {
  return { allowed: false, reason: "Conductor cannot approve launch; a human operator must authorise via the launch gate." };
}

/**
 * Verify that a claimed agent is genuinely allowed to act as Conductor.
 * Only ORCH may use Conductor authority.
 */
export function isConductorAgent(agentCode: AgentCode): boolean {
  return agentCode === CONDUCTOR_AGENT_CODE;
}

/**
 * Check whether the Conductor is allowed to trigger a job for the given permission level.
 * The Conductor may only trigger GREEN jobs autonomously.
 */
export function conductorCanTriggerJob(permissionLevel: PermissionLevel): PolicyDecision {
  return conductorCanPerformAction(permissionLevel);
}

/**
 * The Conductor may advance the project state machine, but only when:
 * - All required gates for the transition are satisfied
 * - No human approval is outstanding
 * - The next state is NOT READY_TO_LAUNCH (launch always requires human)
 */
export function conductorCanAdvanceState(
  data: OSData,
  projectId: string,
  toState: ProjectState,
): PolicyDecision {
  if (toState === "READY_TO_LAUNCH" || toState === "LIVE") {
    return { allowed: false, reason: `Conductor cannot advance to ${toState}; requires human launch approval.` };
  }
  const pendingApprovals = data.jobApprovals.filter(
    (a) => a.projectId === projectId && a.status === "PENDING",
  );
  if (pendingApprovals.length > 0) {
    return { allowed: false, reason: `Cannot advance: ${pendingApprovals.length} pending approval(s) must be resolved first.` };
  }
  const openHolds = data.launchHolds.filter((h) => h.projectId === projectId && !h.resolved);
  if (openHolds.length > 0) {
    return { allowed: false, reason: `Cannot advance: ${openHolds.length} open launch hold(s) must be cleared first.` };
  }
  return { allowed: true, reason: "All gates satisfied; Conductor may advance." };
}

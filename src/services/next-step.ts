/**
 * Project Next Step resolver (CTOS-005A Part 7).
 *
 * Deterministic — the Conductor/LLM cannot invent workflow transitions.
 * Always answers exactly one of:
 *   - AGENT_ACTION: a specific agent should run next
 *   - HUMAN_ACTION: a specific human must act
 *   - BLOCKED: progress is blocked; detail explains why
 *   - COMPLETE: project is in a terminal state
 */
import type { AgentCode, OSData, ProjectState } from "@/data/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NextStepOutcome = "AGENT_ACTION" | "HUMAN_ACTION" | "BLOCKED" | "COMPLETE";

export interface NextStep {
  outcome: NextStepOutcome;
  /** Which agent should act next (AGENT_ACTION only). */
  agentCode: AgentCode | null;
  /** Human-readable summary of what must happen. */
  action: string;
  /** Why progress is blocked or what the blocker is. */
  blocker: string | null;
  /** The project state this was computed for. */
  forState: ProjectState;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Compute the next step for a project.
 * Checks live data (pending approvals, NEEDS_A_HAND jobs, open holds, etc.)
 * before applying the state-machine default.
 */
export function resolveNextStep(data: OSData, projectId: string): NextStep {
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) {
    return blocked("PROJECT_NOT_FOUND", "Project not found", "DISCOVERY");
  }

  const state = project.state as ProjectState;

  // Terminal states
  if (state === "LIVE" || state === "ARCHIVED") {
    return { outcome: "COMPLETE", agentCode: null, action: "Project is in a terminal state.", blocker: null, forState: state };
  }

  // Cross-cutting blockers checked before state-specific logic

  // NEEDS_A_HAND jobs always block
  const needsHandJobs = data.agentJobs.filter((j) => j.projectId === projectId && j.status === "NEEDS_A_HAND");
  if (needsHandJobs.length > 0) {
    const job = needsHandJobs[0]!;
    return blocked(
      `Job ${job.id} (${job.taskType}) is in NEEDS_A_HAND. Use Mode B (external assistant) or Mode C (manual completion) to continue.`,
      `${needsHandJobs.length} job(s) require operator attention.`,
      state,
    );
  }

  // Open launch holds block
  const openHolds = data.launchHolds.filter((h) => h.projectId === projectId && !h.resolved);
  if (openHolds.length > 0) {
    return human("Resolve all open launch holds before proceeding.", `${openHolds.length} open hold(s).`, state);
  }

  // Pending approvals block
  const pendingApprovals = data.jobApprovals.filter((a) => a.projectId === projectId && a.status === "PENDING");
  if (pendingApprovals.length > 0) {
    return human(
      `Approve ${pendingApprovals.length} pending artifact(s) to continue.`,
      "Workflow paused at approval gate.",
      state,
    );
  }

  // Build-pack conflicts block READY_TO_BUILD
  if (state === "READY_TO_BUILD" || state === "BUILDING") {
    const conflictPack = data.buildPacks.find((bp) => bp.projectId === projectId && bp.status === "CONFLICT");
    if (conflictPack) {
      return blocked(
        `Build pack ${conflictPack.id} has ${conflictPack.conflicts.length} conflict(s). Resolve them before Agent 05 can begin.`,
        "Build pack conflict.",
        state,
      );
    }
  }

  // State-specific next steps
  return stateNextStep(data, projectId, state);
}

function stateNextStep(data: OSData, projectId: string, state: ProjectState): NextStep {
  switch (state) {
    case "NEW":
    case "DISCOVERY":
      return agent("A01", "Agent 01 (Discovery) should research the business and existing site.", state);

    case "STRATEGY":
      return agent("A02", "Agent 02 (UX & Conversion Architect) should produce the site blueprint.", state);

    case "DESIGN":
    case "DESIGN_AND_CONTENT": {
      const hasBlueprint = data.artifacts.some((a) => a.projectId === projectId && a.type === "site_blueprint" && a.status === "FINAL");
      if (!hasBlueprint) return blocked("No approved site blueprint. Agent 02 must complete the blueprint first.", "Missing site_blueprint.", state);
      const hasDirection = data.artifacts.some((a) => a.projectId === projectId && a.type === "design_direction" && a.status === "FINAL");
      if (!hasDirection) return agent("A03", "Agent 03 (Creative Director) should run the DIRECTION pass and produce a design_direction artifact.", state);
      const hasComposition = data.artifacts.some((a) => a.projectId === projectId && a.type === "page_composition" && a.status === "FINAL");
      if (!hasComposition) return agent("A03", "Agent 03 (Creative Director) should run the COMPOSITION pass and produce a page_composition artifact.", state);
      const hasDesign = data.artifacts.some((a) => a.projectId === projectId && a.type === "design_system" && a.status === "FINAL");
      const hasContent = data.artifacts.some((a) => a.projectId === projectId && a.type === "content_pack" && a.status === "FINAL");
      if (!hasDesign) return agent("A03", "Agent 03 (Creative Director) should produce the design system.", state);
      if (!hasContent) return agent("A04", "Agent 04 (Content) should produce the content pack.", state);
      // Check open design↔content reconciliations (CTOS-005B Part 17)
      const openRecs = data.designContentReconciliations.filter((r) => r.projectId === projectId && r.status === "OPEN");
      if (openRecs.length > 0) return human(`Resolve ${openRecs.length} open design↔content reconciliation(s) before advancing.`, "Open reconciliations.", state);
      return human("Direction, composition, design system and content pack complete. Review reconciliations and approve to advance to READY_TO_BUILD.", null, state);
    }

    case "CONTENT":
      return agent("A04", "Agent 04 (Content Architect) should produce the content pack.", state);

    case "READY_TO_BUILD": {
      const readyPack = data.buildPacks.find((bp) => bp.projectId === projectId && bp.status === "READY");
      if (!readyPack) return human("Assemble and approve the build pack before Agent 05 can begin.", "No READY build pack.", state);
      return agent("A05", "Agent 05 (Builder) should build the site from the approved build pack.", state);
    }

    case "BUILDING": {
      // CTOS-006: WP write conflicts or failures block BUILDING completion
      const wpConflicts = data.websiteWriteResults.filter((r) => r.projectId === projectId && r.status === "CONFLICT_DETECTED");
      if (wpConflicts.length > 0) return blocked(`${wpConflicts.length} website write conflict(s) require operator review before building can continue.`, "WP write conflicts.", state);
      const wpFailed = data.websiteWriteResults.filter(
        (r) =>
          r.projectId === projectId &&
          (r.status === "FAILED_WRITE" || r.status === "FAILED_READBACK" || r.status === "NEEDS_A_HAND"),
      );
      if (wpFailed.length > 0) return blocked(`${wpFailed.length} website write failure(s) require resolution before building can continue.`, "WP write failures.", state);
      const pendingPlans = data.websiteChangePlans.filter(
        (p) => p.projectId === projectId && (p.status === "READY" || p.status === "EXECUTING"),
      );
      if (pendingPlans.length > 0) return human(`${pendingPlans.length} website change plan(s) pending. Approve or wait for execution to complete.`, "WP change plans pending.", state);
      return agent("A05", "Agent 05 (Builder) is building the site. Monitor for completion.", state);
    }

    case "QA": {
      const hasQA = data.qaItems.some((q) => q.projectId === projectId);
      if (!hasQA) return agent("A06", "Agent 06 (QA Auditor) should run the site audit.", state);
      const criticals = data.qaItems.filter((q) => q.projectId === projectId && q.severity === "P0" && q.status !== "VERIFIED" && q.status !== "WONT_FIX");
      if (criticals.length > 0) return blocked(`${criticals.length} CRITICAL QA defect(s) must be resolved before client review.`, "Open CRITICAL defects.", state);
      const majors = data.qaItems.filter((q) => q.projectId === projectId && q.severity === "P1" && q.status !== "VERIFIED" && q.status !== "WONT_FIX");
      if (majors.length > 0) return blocked(`${majors.length} MAJOR QA defect(s) must be resolved before client review.`, "Open MAJOR defects.", state);
      // CTOS-005B Part 28: Visual defects (P0/P1) also block QA exit
      const criticalVisual = data.visualDefects.filter((d) => d.projectId === projectId && (d.severity === "P0" || d.severity === "P1") && d.status !== "VERIFIED" && d.status !== "WONT_FIX");
      if (criticalVisual.length > 0) return blocked(`${criticalVisual.length} blocking visual defect(s) must be resolved before client review.`, "Open visual defects.", state);
      return human("QA complete. Review results and advance to CLIENT_REVIEW.", null, state);
    }

    case "CLIENT_REVIEW": {
      const unconfirmed = data.changeRequests.filter((cr) => cr.projectId === projectId && cr.confirmedAt === null);
      if (unconfirmed.length > 0) return human(`Classify ${unconfirmed.length} unconfirmed change request(s) before proceeding.`, "Unclassified change requests.", state);
      const openRound = data.revisionRounds.find((r) => r.projectId === projectId && r.completedAt === null);
      if (openRound) return human("Complete the current revision round before advancing.", "Open revision round.", state);
      return human("Client review complete. Approve to advance to READY_TO_LAUNCH.", null, state);
    }

    case "READY_TO_LAUNCH":
      return human("Human operator must approve launch. Agent 07 will execute the deployment runbook.", "Launch requires human approval.", state);

    case "MAINTENANCE": {
      // CTOS-006: Active WP write operations surface as human actions in MAINTENANCE
      const mWpConflicts = data.websiteWriteResults.filter((r) => r.projectId === projectId && r.status === "CONFLICT_DETECTED");
      if (mWpConflicts.length > 0) return human(`${mWpConflicts.length} website write conflict(s) require review. A human edited the page during an automated write.`, "WP write conflict.", state);
      const mPendingPlans = data.websiteChangePlans.filter((p) => p.projectId === projectId && p.status === "READY");
      if (mPendingPlans.length > 0) return human(`${mPendingPlans.length} website change plan(s) awaiting approval.`, "WP change plan approval required.", state);
      return human("Site is live. Maintenance requests should create new jobs.", null, state);
    }

    default:
      return blocked(`Unrecognised project state: ${state}`, "Unknown state.", state as ProjectState);
  }
}

function agent(code: AgentCode, action: string, forState: ProjectState): NextStep {
  return { outcome: "AGENT_ACTION", agentCode: code, action, blocker: null, forState };
}

function human(action: string, blocker: string | null, forState: ProjectState): NextStep {
  return { outcome: "HUMAN_ACTION", agentCode: null, action, blocker, forState };
}

function blocked(detail: string, blocker: string, forState: ProjectState): NextStep {
  return { outcome: "BLOCKED", agentCode: null, action: "Resolve the blocker before proceeding.", blocker: `${blocker} ${detail}`.trim(), forState };
}

/**
 * Design & Visual Quality Gates (CTOS-005B Parts 18–19).
 *
 * Part 18 — Pre-READY_TO_BUILD design quality gate:
 *   Requires: approved blueprint + direction + composition + content + all reconciliations resolved
 *   + approved build pack. If any condition fails, assembly is blocked.
 *
 * Part 19 — Post-build visual gate:
 *   Sequence: BUILD → SCREENSHOT_CAPTURE → A03 VISUAL_REVIEW → A06 QA → HUMAN APPROVAL
 *   Each step has a deterministic pass/fail check.
 *
 * All functions are pure; no OSData writes.
 */
import type { ArtifactType, OSData } from "@/data/types";
import { openReconciliations } from "./design-content-reconciliation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DesignGateStatus = "PASS" | "BLOCKED";

export interface DesignGateResult {
  status: DesignGateStatus;
  passed: string[];
  blockers: string[];
}

export type PostBuildVisualStage =
  | "BUILD"
  | "SCREENSHOT_CAPTURE"
  | "A03_VISUAL_REVIEW"
  | "A06_QA"
  | "HUMAN_APPROVAL"
  | "APPROVED";

// ---------------------------------------------------------------------------
// Part 18 — Pre-READY_TO_BUILD design quality gate
// ---------------------------------------------------------------------------

const REQUIRED_FINAL_ARTIFACTS: ArtifactType[] = [
  "site_blueprint",
  "design_direction",
  "page_composition",
  "content_pack",
];

/**
 * Check the design quality gate for a project.
 * All conditions must pass before Agent 05 receives a build pack.
 */
export function checkDesignGate(data: OSData, projectId: string): DesignGateResult {
  const passed: string[] = [];
  const blockers: string[] = [];

  const hasFinal = (type: ArtifactType) =>
    data.artifacts.some((a) => a.projectId === projectId && a.type === type && a.status === "FINAL");

  for (const type of REQUIRED_FINAL_ARTIFACTS) {
    if (hasFinal(type)) {
      passed.push(`${type} FINAL`);
    } else {
      blockers.push(`Missing FINAL ${type} artifact`);
    }
  }

  // All design↔content reconciliations must be resolved
  const openRecs = openReconciliations(data, projectId);
  if (openRecs.length === 0) {
    passed.push("No open design↔content reconciliations");
  } else {
    blockers.push(`${openRecs.length} open design↔content reconciliation(s) must be resolved`);
  }

  // A READY build pack must exist
  const readyPack = data.buildPacks.find((bp) => bp.projectId === projectId && bp.status === "READY");
  if (readyPack) {
    passed.push("Build pack READY");
  } else {
    const conflictPack = data.buildPacks.find((bp) => bp.projectId === projectId && bp.status === "CONFLICT");
    if (conflictPack) {
      blockers.push(`Build pack has ${conflictPack.conflicts.length} conflict(s)`);
    } else {
      blockers.push("No READY build pack — assemble one before advancing to READY_TO_BUILD");
    }
  }

  return { status: blockers.length === 0 ? "PASS" : "BLOCKED", passed, blockers };
}

// ---------------------------------------------------------------------------
// Part 19 — Post-build visual gate
// ---------------------------------------------------------------------------

/**
 * Determine the current post-build visual gate stage for a project.
 * Reads screenshot evidence, visual review artifacts, and QA items.
 */
export function postBuildVisualStage(data: OSData, projectId: string): PostBuildVisualStage {
  // Check for human approval (final gate)
  const latestApproval = data.approvals.find((a) => a.projectId === projectId && a.gate === "STAGING_BUILD" && a.status === "APPROVED");
  if (latestApproval) return "APPROVED";

  // Check for A06 QA visual review complete
  const hasQAVisualReview = data.artifacts.some(
    (a) => a.projectId === projectId && a.type === "visual_review" && a.status !== "REJECTED" && a.createdByAgentId === "agent_06",
  );
  if (hasQAVisualReview) return "HUMAN_APPROVAL";

  // Check for A03 visual review
  const hasA03VisualReview = data.artifacts.some(
    (a) => a.projectId === projectId && a.type === "visual_review" && a.status !== "REJECTED" && a.createdByAgentId === "agent_03",
  );
  if (hasA03VisualReview) return "A06_QA";

  // Check for screenshot evidence
  const hasScreenshots = data.screenshotEvidence.some((s) => s.projectId === projectId && s.captureStatus === "captured");
  if (hasScreenshots) return "A03_VISUAL_REVIEW";

  // Check for build completion
  const buildComplete = data.artifacts.some(
    (a) => a.projectId === projectId && (a.type === "build_report" || a.type === "elementor_build_manifest") && a.status === "FINAL",
  );
  if (buildComplete) return "SCREENSHOT_CAPTURE";

  return "BUILD";
}

/** Human-readable description of what must happen in the current stage. */
export function postBuildVisualStageAction(stage: PostBuildVisualStage): string {
  const actions: Record<PostBuildVisualStage, string> = {
    BUILD: "Agent 05 must complete the build and produce a FINAL build report",
    SCREENSHOT_CAPTURE: "Capture screenshots at all required viewports (1440px + 375px minimum)",
    A03_VISUAL_REVIEW: "Agent 03 must run a VISUAL_REVIEW pass on the captured screenshots",
    A06_QA: "Agent 06 must independently review the build (visual, responsive, journey, technical)",
    HUMAN_APPROVAL: "Human operator must approve the build before launch",
    APPROVED: "Build approved — proceed to launch readiness",
  };
  return actions[stage];
}

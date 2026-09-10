/**
 * Visual verification integrity (CTOS-005A Final Pass).
 *
 * Single central validator for visual verification state.
 * Rule hierarchy:
 *   1. No evidence → VISUAL_NOT_VERIFIED
 *   2. Evidence filtered to wrong project or wrong job → VISUAL_NOT_VERIFIED
 *   3. Evidence present but all captures failed/pending → VISUAL_NOT_VERIFIED
 *   4. At least one successful capture passes the filter → VISUAL_VERIFIED
 *
 * DOM inspection, text crawl, metadata, and SEO analysis are NEVER sufficient
 * for VISUAL_VERIFIED — only real screenshot captures count.
 */
import type { ScreenshotEvidence, VisualVerificationState } from "@/data/types";

export type { VisualVerificationState };

export interface VisualVerificationOpts {
  /** When set, only evidence for this project is counted. Cross-project evidence is rejected. */
  projectId?: string;
  /** When set, only evidence for this job is counted. Wrong-job evidence is rejected. */
  jobId?: string;
}

/**
 * Assess visual verification state from a set of screenshot evidence records.
 *
 * @param evidence - Screenshot evidence records (may be empty).
 * @param opts     - Optional scope filters; cross-project or wrong-job evidence is rejected.
 * @returns VISUAL_VERIFIED only when at least one in-scope capture succeeded.
 */
export function assessVisualVerification(
  evidence: ScreenshotEvidence[],
  opts?: VisualVerificationOpts,
): VisualVerificationState {
  if (!evidence || evidence.length === 0) return "VISUAL_NOT_VERIFIED";

  let scoped = evidence;

  if (opts?.projectId !== undefined) {
    scoped = scoped.filter((e) => e.projectId === opts.projectId);
  }
  if (opts?.jobId !== undefined) {
    scoped = scoped.filter((e) => e.jobId === opts.jobId);
  }

  if (scoped.length === 0) return "VISUAL_NOT_VERIFIED";

  const hasCaptured = scoped.some((e) => e.captureStatus === "captured");
  return hasCaptured ? "VISUAL_VERIFIED" : "VISUAL_NOT_VERIFIED";
}

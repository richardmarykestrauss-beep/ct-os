/**
 * Screenshot set validation (CTOS-005B Parts 6–8).
 *
 * - Part 6: Extended screenshot evidence model (5 viewports: 1440/1024/768/480/375).
 * - Part 7: Screenshot set validation — missing coverage, failed captures, duplicates, stale.
 * - Part 8: Visual comparison type helpers.
 *
 * All functions are pure; no network calls.
 */
import type {
  ExtendedScreenshotEvidence,
  ISODate,
  QASeverity,
  ScreenshotSetIssue,
  ScreenshotSetValidationResult,
  ScreenshotViewport,
  VisualComparison,
  VisualComparisonFinding,
  VisualComparisonFindingKind,
  VisualComparisonKind,
} from "@/data/types";
import { REQUIRED_VIEWPORTS, SCREENSHOT_VIEWPORTS } from "@/data/types";

// ---------------------------------------------------------------------------
// Part 7 — Screenshot set validation
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Validate a set of ExtendedScreenshotEvidence records for a single URL/page.
 *
 * Rules:
 *   - Required viewports (1440, 375) must have at least one "captured" screenshot each.
 *   - No two records may share the same viewport (duplicate_viewport).
 *   - Any "failed" capture is surfaced as an issue.
 *   - Screenshots older than 7 days are flagged stale_evidence (non-blocking; informational).
 */
export function validateScreenshotSet(evidence: ExtendedScreenshotEvidence[], now: ISODate | null = null): ScreenshotSetValidationResult {
  const issues: ScreenshotSetIssue[] = [];
  const captured = evidence.filter((e) => e.captureStatus === "captured");
  const capturedViewports = new Set(captured.map((e) => e.viewport));

  // Check required viewports
  for (const vp of REQUIRED_VIEWPORTS) {
    if (!capturedViewports.has(vp)) {
      const kind: ScreenshotSetIssue["kind"] = vp === 1440 ? "missing_desktop" : "missing_mobile";
      issues.push({ kind, viewport: vp, detail: `No captured screenshot at ${vp}px viewport` });
    }
  }

  // Check all viewports for failed captures
  for (const e of evidence) {
    if (e.captureStatus === "failed") {
      issues.push({ kind: "failed_capture", viewport: e.viewport, detail: `Capture failed at ${e.viewport}px: ${e.loadErrors.join("; ") || "unknown error"}` });
    }
  }

  // Check for duplicate viewports (only among captured)
  const viewportCounts = new Map<ScreenshotViewport, number>();
  for (const e of captured) {
    viewportCounts.set(e.viewport, (viewportCounts.get(e.viewport) ?? 0) + 1);
  }
  for (const [vp, count] of viewportCounts.entries()) {
    if (count > 1) {
      issues.push({ kind: "duplicate_viewport", viewport: vp, detail: `${count} screenshots at ${vp}px — only the most recent should be used` });
    }
  }

  // Check staleness
  if (now) {
    const nowMs = new Date(now).getTime();
    for (const e of captured) {
      if (e.capturedAt) {
        const ageMs = nowMs - new Date(e.capturedAt).getTime();
        if (ageMs > STALE_THRESHOLD_MS) {
          issues.push({ kind: "stale_evidence", viewport: e.viewport, detail: `Screenshot at ${e.viewport}px is ${Math.floor(ageMs / 86400000)} days old` });
        }
      }
    }
  }

  const coverage = SCREENSHOT_VIEWPORTS.filter((vp) => capturedViewports.has(vp));
  const missingViewports = SCREENSHOT_VIEWPORTS.filter((vp) => !capturedViewports.has(vp));

  const blockingIssues = issues.filter((i) => i.kind === "missing_desktop" || i.kind === "missing_mobile" || i.kind === "failed_capture");
  const valid = blockingIssues.length === 0;

  return { valid, issues, coverage, missingViewports };
}

/**
 * Check if a set of evidence covers both required viewports (1440 + 375) with "captured" status.
 * Convenience predicate — prefer validateScreenshotSet for full detail.
 */
export function hasRequiredCoverage(evidence: ExtendedScreenshotEvidence[]): boolean {
  const capturedViewports = new Set(evidence.filter((e) => e.captureStatus === "captured").map((e) => e.viewport));
  return REQUIRED_VIEWPORTS.every((vp) => capturedViewports.has(vp));
}

// ---------------------------------------------------------------------------
// Part 8 — Visual comparison helpers
// ---------------------------------------------------------------------------

/** Create a VisualComparison record from a kind and list of findings. */
export function createVisualComparison(
  id: string,
  projectId: string,
  jobId: string | null,
  kind: VisualComparisonKind,
  findings: VisualComparisonFinding[],
  summary: string,
  createdAt: ISODate | null = null,
): VisualComparison {
  return { id, projectId, jobId, kind, findings, summary, createdAt };
}

/** Build a single VisualComparisonFinding. */
export function finding(
  kind: VisualComparisonFindingKind,
  description: string,
  severity: QASeverity,
  viewport?: ScreenshotViewport,
): VisualComparisonFinding {
  return viewport !== undefined ? { kind, description, severity, viewport } : { kind, description, severity };
}

/** True when any finding in the comparison is P0 or P1 (blocking). */
export function hasBlockingFindings(comparison: VisualComparison): boolean {
  return comparison.findings.some((f) => f.severity === "P0" || f.severity === "P1");
}

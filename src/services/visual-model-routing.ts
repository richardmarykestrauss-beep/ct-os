/**
 * Visual model routing (CTOS-005B Part 24).
 *
 * Routes A03 VISUAL_REVIEW jobs to vision-capable providers and falls back to Mode B
 * when no vision provider is available. Preserves A03 agent identity regardless of
 * which provider executes the job.
 *
 * The ModelRouter already enforces requiredCapabilities at runtime (ai/router.ts).
 * This module provides the planning-time check and the Mode B escalation path so
 * callers can decide *before* starting a job whether a live API run is possible.
 */
import type { AgentJob, AgentTaskType, OSData, ProviderCapability, ProviderId } from "@/data/types";
import { selectCapableProvider, capabilityGapDiagnostic } from "./capability-registry";
import { assembleJobPack } from "./job-pack";
import type { JobPack } from "@/data/types";

// ---------------------------------------------------------------------------
// Capability constants
// ---------------------------------------------------------------------------

/** Capabilities required for any VISUAL_REVIEW job. vision is non-negotiable. */
export const VISUAL_REVIEW_REQUIRED_CAPS: ProviderCapability[] = ["text", "structured_output", "vision"];

// ---------------------------------------------------------------------------
// Task-type guards
// ---------------------------------------------------------------------------

/** Returns true when the task type requires a vision-capable provider. */
export function requiresVisionCapability(taskType: AgentTaskType): boolean {
  return taskType === "visual_review";
}

/**
 * Safety guard: ensures `vision` appears in a VISUAL_REVIEW job's requiredCapabilities.
 * A03 already declares vision in its agent record; this catches any manual override
 * that accidentally drops it. No-ops for non-VISUAL_REVIEW task types.
 */
export function enforceVisionCapability(job: AgentJob): AgentJob {
  if (!requiresVisionCapability(job.taskType)) return job;
  if (job.requiredCapabilities.includes("vision")) return job;
  return { ...job, requiredCapabilities: [...job.requiredCapabilities, "vision"] };
}

// ---------------------------------------------------------------------------
// Vision provider selection
// ---------------------------------------------------------------------------

export interface VisionRoutingDecision {
  /** Chosen provider, or null if none satisfies the vision requirement. */
  provider: ProviderId | null;
  /** True when the job must move to NEEDS_A_HAND / Mode B export. */
  fallbackToModeB: boolean;
  /** Human-readable explanation of the decision. */
  diagnostic: string;
}

/**
 * Select a vision-capable provider from the ordered fallback list.
 * - Preferred provider is tried first; if it lacks vision, the next fallback is tried.
 * - Returns `fallbackToModeB: true` when no configured provider satisfies vision.
 * - Never silently downgrades VISUAL_REVIEW into text-only reasoning.
 *
 * @param orderedProviders  Providers in preference order (preferred first, then fallbacks).
 * @param overrides         Optional per-provider capability overrides (for tests / dry-runs).
 */
export function routeVisualReviewJob(
  orderedProviders: ProviderId[],
  overrides?: Partial<Record<ProviderId, ProviderCapability[]>>,
): VisionRoutingDecision {
  const provider = selectCapableProvider(orderedProviders, VISUAL_REVIEW_REQUIRED_CAPS, overrides);
  if (provider) {
    const isPreferred = provider === orderedProviders[0];
    return {
      provider,
      fallbackToModeB: false,
      diagnostic: isPreferred
        ? `Preferred provider ${provider} satisfies all visual review capabilities.`
        : `Preferred provider(s) lacked vision capability; routed to fallback provider ${provider}.`,
    };
  }
  const gap = capabilityGapDiagnostic(VISUAL_REVIEW_REQUIRED_CAPS, orderedProviders, overrides);
  return {
    provider: null,
    fallbackToModeB: true,
    diagnostic: `No vision-capable provider available — VISUAL_REVIEW must go to Mode B.\n${gap}`,
  };
}

// ---------------------------------------------------------------------------
// Mode B job pack with screenshot evidence refs
// ---------------------------------------------------------------------------

export interface VisualReviewScreenshotRef {
  screenshotId: string;
  viewport: string;
  url: string;
  captureStatus: string;
}

export interface VisualReviewJobPackResult {
  jobPack: JobPack;
  /** Screenshot evidence references included in the pack's evidenceExpectations. */
  screenshotRefs: VisualReviewScreenshotRef[];
}

/**
 * Assemble a job pack for a VISUAL_REVIEW job, enriched with screenshot evidence references.
 *
 * When the job goes to Mode B, the operator (or external assistant) must know which
 * screenshots accompany the task. This function appends screenshot evidence IDs to
 * `evidenceExpectations` so the Mode B recipient has the full visual context.
 *
 * A03 agent identity (agentId, agentCode, agentCharter) is preserved exactly as
 * assembled by assembleJobPack — no agent substitution occurs.
 */
export function assembleVisualReviewJobPack(
  data: OSData,
  jobId: string,
): VisualReviewJobPackResult {
  const job = data.agentJobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const { jobPack } = assembleJobPack(data, jobId);

  // Collect captured screenshots scoped to this job's project
  const projectShots = data.screenshotEvidence.filter(
    (s) => s.projectId === job.projectId && s.captureStatus === "captured",
  );

  const screenshotRefs: VisualReviewScreenshotRef[] = projectShots.map((s) => ({
    screenshotId: s.id,
    viewport: s.viewport,
    url: s.url,
    captureStatus: s.captureStatus,
  }));

  const evidenceLines = screenshotRefs.map(
    (r) => `screenshot:${r.screenshotId}:viewport:${r.viewport}:url:${r.url}`,
  );

  const enrichedPack: JobPack = {
    ...jobPack,
    evidenceExpectations: [...jobPack.evidenceExpectations, ...evidenceLines],
  };

  return { jobPack: enrichedPack, screenshotRefs };
}

/**
 * Provenance service (CTOS-005A Part 25).
 *
 * Records the full execution lineage of every agent job.
 * Provenance is append-only — records are never deleted or modified after creation.
 */
import type {
  AgentCode,
  AgentJob,
  AgentRun,
  ContextReductionRecord,
  JobPackTransport,
  OSData,
  ProvenanceRecord,
  ProviderId,
  RetryTelemetry,
  ScreenshotEvidence,
  ValidationResult,
} from "@/data/types";
import { newId, nowIso } from "@/lib/core";

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface ProvenanceBuildOpts {
  executionMode: "A" | "B" | "C";
  transport: JobPackTransport;
  provider: ProviderId | null;
  model: string | null;
  agentCode: AgentCode;
  skillId: string | null;
  skillVersion: number | null;
  evidenceIds: string[];
  screenshotIds: string[];
  validationResult: ValidationResult | null;
  failedAttempts: number;
  fallbackReason: string | null;
  operatorId: string | null;
  contextReductions: ContextReductionRecord[];
  retryTelemetry: RetryTelemetry | null;
}

/** Build a ProvenanceRecord for a completed job. */
export function buildProvenanceRecord(
  job: AgentJob,
  runs: AgentRun[],
  opts: ProvenanceBuildOpts,
): ProvenanceRecord {
  return {
    projectId: job.projectId,
    jobId: job.id,
    agentId: job.agentId,
    agentCode: opts.agentCode,
    provider: opts.provider,
    model: opts.model,
    executionMode: opts.executionMode,
    transport: opts.transport,
    skillId: opts.skillId,
    skillVersion: opts.skillVersion,
    inputArtifactIds: job.inputArtifactIds,
    evidenceIds: opts.evidenceIds,
    screenshotIds: opts.screenshotIds,
    validationResult: opts.validationResult,
    attemptCount: runs.length,
    failedAttempts: opts.failedAttempts,
    fallbackReason: opts.fallbackReason,
    operatorId: opts.operatorId,
    contextReductions: opts.contextReductions,
    retryTelemetry: opts.retryTelemetry,
    timestamp: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Screenshot evidence
// ---------------------------------------------------------------------------

/** Attach screenshot evidence to the data store. */
export function attachScreenshotEvidence(data: OSData, evidence: ScreenshotEvidence): OSData {
  return { ...data, screenshotEvidence: [...data.screenshotEvidence, evidence] };
}

/** Build a ScreenshotEvidence record from a captured viewport. */
export function buildScreenshotEvidence(opts: {
  jobId: string;
  projectId: string;
  url: string;
  viewport: ScreenshotEvidence["viewport"];
  widthPx: number;
  heightPx: number;
  capturedAt: string;
  captureStatus: ScreenshotEvidence["captureStatus"];
  consoleErrors: string[];
  loadErrors: string[];
}): ScreenshotEvidence {
  return {
    id: newId("ss"),
    projectId: opts.projectId,
    jobId: opts.jobId,
    url: opts.url,
    viewport: opts.viewport,
    widthPx: opts.widthPx,
    heightPx: opts.heightPx,
    capturedAt: opts.capturedAt,
    captureStatus: opts.captureStatus,
    consoleErrors: opts.consoleErrors,
    loadErrors: opts.loadErrors,
  };
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

/** Return a one-line provenance summary for a job. */
export function jobProvenanceSummary(job: AgentJob, runs: AgentRun[]): string {
  const parts: string[] = [`Job ${job.id} | Agent ${job.agentId} | Mode ${job.executionMode ?? "A"}`];
  parts.push(`Status: ${job.status} | Attempts: ${runs.length}`);
  if (job.executionMode === "B") parts.push("Transport: external subscription");
  if (job.executionMode === "C") parts.push("Transport: manual");
  return parts.join(" | ");
}

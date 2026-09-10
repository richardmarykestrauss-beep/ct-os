/**
 * Mode B — Assisted/External Subscription execution (CTOS-005A Part 9).
 *
 * When autonomous API execution fails, CT-OS moves the job to NEEDS_A_HAND
 * and exposes three operator controls:
 *   COPY PACK   — export the job pack for use in an external assistant
 *   PASTE RESULT — import and validate the result
 *   MARK DONE MANUALLY — Mode C: operator completes the artifact directly
 *
 * Imports validate against the same Zod contract as API execution.
 * Manual transport is recorded honestly — never masqueraded as an API call.
 */
import type {
  ExecutionMode,
  JobPack,
  JobPackTransport,
  ModeBJob,
  ModeBStatus,
  OSData,
} from "@/data/types";
import { newId, nowIso } from "@/lib/core";
import { sha256Hex as hash } from "@/lib/hash";
import { exportJobPack, validateModeBImport } from "./job-pack";
import { validateOutput, parseSchemaName } from "@/schemas/artifacts";
import { transitionJob } from "./agent-jobs";
import { createArtifact, createArtifactVersion, setArtifactStatus } from "./artifacts";

// ---------------------------------------------------------------------------
// Mode B lifecycle
// ---------------------------------------------------------------------------

/** Create a Mode B job record when a job moves to NEEDS_A_HAND (Part 9). */
export function createModeBJob(
  data: OSData,
  jobId: string,
  transport: Exclude<JobPackTransport, "API">,
  operatorId: string | null,
  operatorName: string | null,
  jobPackId: string | null,
): { data: OSData; modeBJob: ModeBJob } {
  const modeBJob: ModeBJob = {
    id: newId("mb"),
    jobId,
    projectId: data.agentJobs.find((j) => j.id === jobId)?.projectId ?? "",
    status: "PENDING_EXPORT",
    transport,
    jobPackHash: null,
    jobPackId,
    exportedAt: null,
    resultImportedAt: null,
    resultRejectedReason: null,
    operatorId,
    operatorName,
    createdAt: nowIso(),
  };
  return { data: { ...data, modeBJobs: [...data.modeBJobs, modeBJob] }, modeBJob };
}

function updateModeBJob(data: OSData, id: string, patch: Partial<ModeBJob>): OSData {
  return {
    ...data,
    modeBJobs: data.modeBJobs.map((mb) => (mb.id === id ? { ...mb, ...patch } : mb)),
  };
}

/** Record that the operator exported the pack (COPY PACK action). */
export function recordModeBExport(
  data: OSData,
  modeBJobId: string,
  jobPack: JobPack,
): { data: OSData; hash: string } {
  const serialized = JSON.stringify(jobPack);
  const packHash = hash(serialized);
  const next = updateModeBJob(data, modeBJobId, {
    status: "EXPORTED" as ModeBStatus,
    jobPackHash: packHash,
    exportedAt: nowIso(),
  });
  return { data: next, hash: packHash };
}

// ---------------------------------------------------------------------------
// PASTE RESULT — validate and import external result
// ---------------------------------------------------------------------------

export interface ModeBImportResult {
  ok: boolean;
  data: OSData;
  artifactId: string | null;
  issues: string[];
}

/**
 * Import a Mode B result (PASTE RESULT action).
 * Validates the output against the expected schema, then applies it exactly
 * as if the API had returned it — preserving job identity, agent identity,
 * skill version, input artifact versions, and project scope.
 * Records transport as "CLAUDE_SUBSCRIPTION" or the declared transport.
 *
 * Refuses invalid output — does not silently coerce malformed content.
 */
export function importModeBResult(
  data: OSData,
  modeBJobId: string,
  rawInput: unknown,
  _opts: {
    operatorId?: string | null;
    externalProvider?: JobPackTransport;
  } = {},
): ModeBImportResult {
  const modeBJob = data.modeBJobs.find((mb) => mb.id === modeBJobId);
  if (!modeBJob) return { ok: false, data, artifactId: null, issues: [`Mode B job ${modeBJobId} not found`] };

  const job = data.agentJobs.find((j) => j.id === modeBJob.jobId);
  if (!job) return { ok: false, data, artifactId: null, issues: [`Job ${modeBJob.jobId} not found`] };

  if (job.status !== "NEEDS_A_HAND") {
    return {
      ok: false,
      data,
      artifactId: null,
      issues: [`Job ${job.id} is ${job.status}; expected NEEDS_A_HAND to accept a Mode B import`],
    };
  }

  // Validate against the same Zod contract as API execution
  const vr = validateModeBImport(modeBJobId, rawInput, job.requiredOutputSchema, (schema, output) => {
    const result = validateOutput(schema, output);
    return { ok: result.ok, issues: result.issues };
  });

  if (!vr.ok) {
    const next = updateModeBJob(data, modeBJobId, {
      status: "RESULT_REJECTED" as ModeBStatus,
      resultRejectedReason: vr.issues.join("\n"),
    });
    return { ok: false, data: next, artifactId: null, issues: vr.issues };
  }

  // Mode B does NOT go through RUNNING — the job was completed externally.
  // Create the artifact directly from NEEDS_A_HAND state, then transition to
  // WAITING_APPROVAL (valid: NEEDS_A_HAND → WAITING_APPROVAL).
  try {
    const type = parseSchemaName(job.requiredOutputSchema).type;
    const title = `${type.replace(/_/g, " ")} — Mode B import`;
    const previous = job.ticketId
      ? data.artifacts.find((a) => a.type === type && a.projectId === job.projectId && a.ticketId === job.ticketId && a.status !== "SUPERSEDED")
      : null;
    const created = previous
      ? createArtifactVersion(data, { previousArtifactId: previous.id, createdByAgentId: job.agentId, createdByProvider: null, jobId: job.id, ticketId: job.ticketId, content: vr.parsedOutput })
      : createArtifact(data, { projectId: job.projectId, type, title, createdByAgentId: job.agentId, createdByProvider: null, jobId: job.id, ticketId: job.ticketId, content: vr.parsedOutput });
    let next = created.data;

    // Tag the job with execution mode B before transitioning
    next = { ...next, agentJobs: next.agentJobs.map((j) => j.id === job.id ? { ...j, executionMode: "B" as ExecutionMode } : j) };

    // NEEDS_A_HAND → WAITING_APPROVAL: artifact is pending human approval
    const t = transitionJob(next, job.id, "WAITING_APPROVAL", { outputArtifactId: created.artifact.id });
    next = setArtifactStatus(t.data, created.artifact.id, "DRAFT");

    const final = updateModeBJob(next, modeBJobId, {
      status: "RESULT_IMPORTED" as ModeBStatus,
      resultImportedAt: nowIso(),
    });
    return { ok: true, data: final, artifactId: created.artifact.id, issues: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const next = updateModeBJob(data, modeBJobId, {
      status: "RESULT_REJECTED" as ModeBStatus,
      resultRejectedReason: msg,
    });
    return { ok: false, data: next, artifactId: null, issues: [msg] };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the current active Mode B job for a given CT-OS job. */
export function activeModeBJob(data: OSData, jobId: string): ModeBJob | null {
  return (
    data.modeBJobs
      .filter(
        (mb) =>
          mb.jobId === jobId &&
          mb.status !== "RESULT_IMPORTED" &&
          mb.status !== "CANCELLED",
      )
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0] ?? null
  );
}

/** Re-export for convenience — avoids importing from job-pack in UI components. */
export { exportJobPack };

/**
 * Audit progress — derived purely from store records (request, AgentJobs, runs, artifacts).
 * The Audit tab renders this; nothing here is timed or simulated.
 */
import type { AgentJob, OSData, WebsiteAuditRequest } from "@/data/types";
import { PROVIDER_LABELS } from "@/ai/registry";
import { JOB_STATUS_LABELS } from "@/services/agent-jobs";
import { AGENT_IDS } from "@/data/seed";

export type AuditStepState = "QUEUED" | "RUNNING" | "COMPLETE" | "PARTIAL" | "FAILED" | "NEEDS_A_HAND" | "CANCELLED";

export interface AuditStep {
  key: string;
  label: string;
  state: AuditStepState;
  detail: string | null;
  job: AgentJob | null;
}

function jobState(job: AgentJob | null, requestStatus: WebsiteAuditRequest["status"]): AuditStepState {
  if (!job) return requestStatus === "FAILED" || requestStatus === "CANCELLED" ? "CANCELLED" : "QUEUED";
  switch (job.status) {
    case "RUNNING":
    case "WAITING_APPROVAL":
      return "RUNNING";
    case "COMPLETED":
      return "COMPLETE";
    case "FAILED":
      return "FAILED";
    case "NEEDS_A_HAND":
      return "NEEDS_A_HAND";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "QUEUED";
  }
}

const AGENT_STEPS: Array<[string, string]> = [
  [AGENT_IDS.A01, "A01 Discovery"],
  [AGENT_IDS.A02, "A02 Site Architect"],
  [AGENT_IDS.A03, "A03 Creative Director"],
  [AGENT_IDS.A04, "A04 Content"],
  [AGENT_IDS.A06, "A06 QA"],
];

export function deriveAuditSteps(data: OSData, request: WebsiteAuditRequest): AuditStep[] {
  const jobs = request.auditJobIds.map((id) => data.agentJobs.find((j) => j.id === id) ?? null);
  const captureArtifact = jobs.find((j) => j)?.inputArtifactIds.map((id) => data.artifacts.find((a) => a.id === id)).find((a) => a?.type === "audit_capture") ?? data.artifacts.find((a) => a.type === "audit_capture" && a.projectId === (request.projectId ?? request.id) && (a.createdAt ?? "") >= (request.createdAt ?? ""));
  const captureState: AuditStepState = captureArtifact ? "COMPLETE" : request.status === "CAPTURING" ? "RUNNING" : request.status === "FAILED" ? "FAILED" : "QUEUED";

  const agentStep = (agentId: string, label: string): AuditStep => {
    const job = jobs.find((j) => j?.agentId === agentId) ?? null;
    const runs = job ? data.agentRuns.filter((r) => r.jobId === job.id) : [];
    const winner = runs.find((r) => r.status === "SUCCEEDED") ?? null;
    const output = job?.outputArtifactId ? data.artifacts.find((a) => a.id === job.outputArtifactId) : null;
    let detail: string | null = null;
    if (winner && job) {
      detail = `${PROVIDER_LABELS[winner.providerId]}${winner.model ? ` · ${winner.model}` : ""}${winner.providerId !== job.preferredProvider ? " (fallback)" : ""}${winner.latencyMs !== null ? ` · ${(winner.latencyMs / 1000).toFixed(1)}s` : ""}${output ? ` · ${output.title} v${output.version}` : ""}`;
    } else if (job && (job.status === "FAILED" || job.status === "NEEDS_A_HAND")) {
      detail = runs.length ? runs.map((r) => `${PROVIDER_LABELS[r.providerId]} — ${r.status.toLowerCase().replace(/_/g, " ")}`).join(" · ") : (job.error ?? JOB_STATUS_LABELS[job.status]);
    } else if (job && job.status === "RUNNING") {
      detail = `preferred ${PROVIDER_LABELS[job.preferredProvider]}${job.fallbackProviders.length ? ` → ${job.fallbackProviders.map((p) => PROVIDER_LABELS[p]).join(" → ")}` : ""}`;
    } else if (job && job.status === "CANCELLED") {
      detail = job.error ?? "cancelled";
    }
    return { key: agentId, label, state: jobState(job, request.status), detail, job };
  };

  const report = request.resultArtifactId ? data.artifacts.find((a) => a.id === request.resultArtifactId) : null;
  const synthesisState: AuditStepState = request.resultArtifactId
    ? request.status === "COMPLETE" ? "COMPLETE" : request.status === "NEEDS_A_HAND" ? "NEEDS_A_HAND" : "PARTIAL"
    : request.status === "FAILED" || request.status === "CANCELLED" ? "CANCELLED" : "QUEUED";

  return [
    { key: "capture", label: "Capture", state: captureState, detail: captureArtifact?.summary ?? null, job: null },
    ...AGENT_STEPS.map(([id, label]) => agentStep(id, label)),
    { key: "synthesis", label: "Synthesis", state: synthesisState, detail: report ? `${report.title} v${report.version}` : null, job: null },
  ];
}

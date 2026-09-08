/**
 * Agent job / execution model.
 *
 * AgentJob is the standard contract for one unit of agent work. Each execution attempt on
 * a provider is an AgentRun. Jobs are executed through the ModelRouter; the results become
 * artifacts and handoffs. Functions are pure (OSData in → OSData out) except `executeJob`,
 * which awaits the router and then applies a pure result step.
 */
import type { Agent, AgentJob, AgentJobStatus, AgentRun, AgentTaskType, ArtifactType, OSData, Ticket } from "@/data/types";
import type { ModelRouter } from "@/ai/router";
import type { ProviderRequest, RouterAttempt, RouterResult } from "@/ai/types";
import { NoProviderAvailableError } from "@/ai/types";
import { createArtifact, createArtifactVersion, latestArtifact, outputSchemaFor, setArtifactStatus } from "./artifacts";
import { createHandoff, transitionHandoff } from "./handoffs";
import { clearTaskKnowledge, knowledgeForJob } from "./knowledge";
import { newId, nowIso } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const JOB_TRANSITIONS: Record<AgentJobStatus, AgentJobStatus[]> = {
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["WAITING_APPROVAL", "COMPLETED", "FAILED", "CANCELLED"],
  WAITING_APPROVAL: ["COMPLETED", "QUEUED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: ["QUEUED"],
  CANCELLED: [],
};

export const JOB_STATUS_LABELS: Record<AgentJobStatus, string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  WAITING_APPROVAL: "Waiting approval",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export function canTransitionJob(from: AgentJobStatus, to: AgentJobStatus) {
  return JOB_TRANSITIONS[from].includes(to);
}

export class JobStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobStateError";
  }
}

export const TASK_TYPE_BY_AGENT: Record<Agent["code"], AgentTaskType> = {
  ORCH: "orchestrate",
  A01: "research",
  A02: "ux_architecture",
  A03: "creative_direction",
  A04: "seo_content",
  A05: "build",
  A06: "qa_audit",
  A07: "deployment",
  A08: "curate_lessons",
};

export interface CreateJobInput {
  projectId: string;
  agentId: string;
  instructions: string;
  ticketId?: string;
  taskType?: AgentTaskType;
  inputArtifactIds?: string[];
  availableToolIds?: string[];
  outputArtifactType?: ArtifactType;
  id?: string;
  at?: string;
}

function getAgent(data: OSData, agentId: string): Agent {
  const agent = data.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  return agent;
}

/** Create a QUEUED job. Provider policy and permission level are copied from the agent at creation time. */
export function createJob(data: OSData, input: CreateJobInput): { data: OSData; job: AgentJob } {
  const agent = getAgent(data, input.agentId);
  const outputType = input.outputArtifactType ?? agent.producesArtifactTypes[0] ?? "other";
  const at = input.at ?? nowIso();
  const job: AgentJob = {
    id: input.id ?? newId("job"),
    projectId: input.projectId,
    agentId: agent.id,
    ticketId: input.ticketId,
    taskType: input.taskType ?? TASK_TYPE_BY_AGENT[agent.code],
    instructions: input.instructions,
    inputArtifactIds: input.inputArtifactIds ?? [],
    availableToolIds: input.availableToolIds ?? [],
    requiredOutputSchema: outputSchemaFor(outputType),
    requiredCapabilities: agent.requiredCapabilities,
    preferredProvider: agent.providerPolicy.preferred,
    fallbackProviders: agent.providerPolicy.fallbacks,
    permissionLevel: agent.permissionLevel,
    status: "QUEUED",
    outputArtifactId: null,
    handoffId: null,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    completedAt: null,
  };
  return { data: { ...data, agentJobs: [...data.agentJobs, job] }, job };
}

/** Build a job from a ticket: consumes the latest artifacts the agent normally reads, records a handoff from their producer. */
export function createJobForTicket(data: OSData, ticket: Ticket, opts: { id?: string; at?: string } = {}): { data: OSData; job: AgentJob } {
  const agent = getAgent(data, ticket.agentId);
  const inputs = agent.consumesArtifactTypes.map((t) => latestArtifact(data, ticket.projectId, t)).filter((a): a is NonNullable<typeof a> => !!a);
  const instructions = [ticket.objective, ticket.scope.length ? `Scope: ${ticket.scope.join("; ")}` : null, ticket.doNotChange.length ? `Do not change: ${ticket.doNotChange.join("; ")}` : null]
    .filter(Boolean)
    .join("\n");
  let result = createJob(data, { ...opts, projectId: ticket.projectId, agentId: agent.id, ticketId: ticket.id, instructions, inputArtifactIds: inputs.map((a) => a.id) });
  // Handoff: from the producer of the primary input artifact (if any and if a different agent) to this agent.
  const primary = inputs.find((a) => a.createdByAgentId && a.createdByAgentId !== agent.id);
  if (primary?.createdByAgentId) {
    const h = createHandoff(result.data, {
      projectId: ticket.projectId,
      sourceAgentId: primary.createdByAgentId,
      destinationAgentId: agent.id,
      inputArtifactIds: inputs.map((a) => a.id),
      jobId: result.job.id,
      status: "ACCEPTED",
      note: `${ticket.code} — ${ticket.title}`,
      at: opts.at,
    });
    const job = { ...result.job, handoffId: h.handoff.id };
    result = { data: { ...h.data, agentJobs: h.data.agentJobs.map((j) => (j.id === job.id ? job : j)) }, job };
  }
  return result;
}

export function transitionJob(data: OSData, jobId: string, to: AgentJobStatus, patch: Partial<AgentJob> = {}): { data: OSData; job: AgentJob } {
  const existing = data.agentJobs.find((j) => j.id === jobId);
  if (!existing) throw new Error(`Job ${jobId} not found`);
  if (!canTransitionJob(existing.status, to)) throw new JobStateError(`Job ${jobId}: ${existing.status} → ${to} is not allowed`);
  const at = nowIso();
  const job: AgentJob = {
    ...existing,
    ...patch,
    status: to,
    updatedAt: at,
    startedAt: to === "RUNNING" && !existing.startedAt ? at : existing.startedAt,
    completedAt: to === "COMPLETED" || to === "FAILED" || to === "CANCELLED" ? at : existing.completedAt,
  };
  return { data: { ...data, agentJobs: data.agentJobs.map((j) => (j.id === jobId ? job : j)) }, job };
}

export function startJob(data: OSData, jobId: string) {
  const r = transitionJob(data, jobId, "RUNNING");
  if (r.job.handoffId) {
    const h = r.data.handoffs.find((x) => x.id === r.job.handoffId);
    if (h && h.status === "ACCEPTED") return { ...r, data: transitionHandoff(r.data, h.id, "IN_PROGRESS").data };
  }
  return r;
}

export function cancelJob(data: OSData, jobId: string, reason?: string) {
  const r = transitionJob(data, jobId, "CANCELLED", { error: reason });
  const job = r.job;
  let next = clearTaskKnowledge(r.data, jobId);
  if (job.handoffId) {
    const h = next.handoffs.find((x) => x.id === job.handoffId);
    if (h && (h.status === "PENDING" || h.status === "ACCEPTED" || h.status === "IN_PROGRESS")) next = transitionHandoff(next, h.id, "CANCELLED").data;
  }
  return { data: next, job };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function runsFromAttempts(job: AgentJob, attempts: RouterAttempt[], result: RouterResult | null, existingCount: number): AgentRun[] {
  return attempts.map((a, i) => ({
    id: newId("run"),
    jobId: job.id,
    projectId: job.projectId,
    agentId: job.agentId,
    providerId: a.providerId,
    model: a.outcome === "succeeded" ? (result?.response.model ?? null) : null,
    attempt: existingCount + i + 1,
    status: a.outcome === "succeeded" ? "SUCCEEDED" : a.outcome === "failed" ? "FAILED" : "SKIPPED",
    outputSummary: a.outcome === "succeeded" ? result?.response.summary : undefined,
    error: a.error,
    inputTokens: a.outcome === "succeeded" ? (result?.response.usage.inputTokens ?? null) : null,
    outputTokens: a.outcome === "succeeded" ? (result?.response.usage.outputTokens ?? null) : null,
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
  }));
}

// ---------------------------------------------------------------------------
// Request assembly
// ---------------------------------------------------------------------------

export function buildProviderRequest(data: OSData, job: AgentJob): ProviderRequest {
  const agent = getAgent(data, job.agentId);
  const knowledge = knowledgeForJob(data, job.projectId, job.id);
  const inputArtifacts = job.inputArtifactIds.map((id) => data.artifacts.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a);
  const systemContext = [
    `You are ${agent.shortCode} ${agent.name} — ${agent.role}. Responsibilities: ${agent.responsibilities.join(", ")}.`,
    `Permission level: ${job.permissionLevel}. You may not exceed it.`,
    `Produce output matching ${job.requiredOutputSchema}.`,
    knowledge.length ? `Knowledge in force:\n${knowledge.map((k) => `- [${k.scope}] ${k.title}: ${k.content}`).join("\n")}` : "No approved knowledge items apply.",
  ].join("\n\n");
  return {
    jobId: job.id,
    agentId: job.agentId,
    taskType: job.taskType,
    systemContext,
    instructions: job.instructions,
    inputArtifacts,
    knowledge,
    requiredOutputSchema: job.requiredOutputSchema,
    requiredCapabilities: job.requiredCapabilities,
    permissionLevel: job.permissionLevel,
    availableToolIds: job.availableToolIds,
  };
}

// ---------------------------------------------------------------------------
// Result application (pure)
// ---------------------------------------------------------------------------

export interface ApplyResultOptions {
  /** Title for the produced artifact. Defaults to the schema label + job id. */
  artifactTitle?: string;
  /** When true (default) the job pauses in WAITING_APPROVAL; a human completes it. */
  requiresApproval?: boolean;
}

/** Record runs, create the output artifact (new version if one exists for the lineage), advance job + handoff. */
export function applyJobResult(data: OSData, jobId: string, result: RouterResult, opts: ApplyResultOptions = {}): { data: OSData; job: AgentJob; runs: AgentRun[]; artifactId: string } {
  const job = data.agentJobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status !== "RUNNING") throw new JobStateError(`Job ${jobId} is ${job.status}, expected RUNNING`);
  const existingRuns = data.agentRuns.filter((r) => r.jobId === jobId).length;
  const runs = runsFromAttempts(job, result.attempts, result, existingRuns);
  let next: OSData = { ...data, agentRuns: [...data.agentRuns, ...runs] };

  const type = job.requiredOutputSchema.split("@")[0] as ArtifactType;
  const previous = job.ticketId ? next.artifacts.find((a) => a.jobId && a.type === type && a.projectId === job.projectId && a.ticketId === job.ticketId && a.status !== "SUPERSEDED") : null;
  const title = opts.artifactTitle ?? `${type.replace(/_/g, " ")} — ${job.taskType}`;
  const created = previous
    ? createArtifactVersion(next, { previousArtifactId: previous.id, createdByAgentId: job.agentId, createdByProvider: result.providerId, jobId: job.id, ticketId: job.ticketId, summary: result.response.summary, content: result.response.output })
    : createArtifact(next, { projectId: job.projectId, type, title, createdByAgentId: job.agentId, createdByProvider: result.providerId, jobId: job.id, ticketId: job.ticketId, summary: result.response.summary, content: result.response.output });
  next = created.data;

  const requiresApproval = opts.requiresApproval ?? true;
  const successfulRun = runs.find((r) => r.status === "SUCCEEDED") ?? null;
  const t = transitionJob(next, jobId, requiresApproval ? "WAITING_APPROVAL" : "COMPLETED", { outputArtifactId: created.artifact.id, error: undefined });
  next = t.data;
  if (t.job.handoffId) {
    const h = next.handoffs.find((x) => x.id === t.job.handoffId);
    if (h && h.status === "IN_PROGRESS" && !requiresApproval) next = transitionHandoff(next, h.id, "COMPLETED", { outputArtifactId: created.artifact.id, runId: successfulRun?.id ?? null }).data;
    else if (h) next = { ...next, handoffs: next.handoffs.map((x) => (x.id === h.id ? { ...x, outputArtifactId: created.artifact.id, runId: successfulRun?.id ?? null, updatedAt: nowIso() } : x)) };
  }
  if (!requiresApproval) {
    next = setArtifactStatus(next, created.artifact.id, "FINAL");
    next = clearTaskKnowledge(next, jobId);
  }
  return { data: next, job: t.job, runs, artifactId: created.artifact.id };
}

export function applyJobFailure(data: OSData, jobId: string, error: NoProviderAvailableError | Error): { data: OSData; job: AgentJob; runs: AgentRun[] } {
  const job = data.agentJobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  const attempts = error instanceof NoProviderAvailableError ? error.attempts : [];
  const existingRuns = data.agentRuns.filter((r) => r.jobId === jobId).length;
  const runs = runsFromAttempts(job, attempts, null, existingRuns);
  let next: OSData = { ...data, agentRuns: [...data.agentRuns, ...runs] };
  const t = transitionJob(next, jobId, "FAILED", { error: error.message });
  next = clearTaskKnowledge(t.data, jobId);
  if (t.job.handoffId) {
    const h = next.handoffs.find((x) => x.id === t.job.handoffId);
    if (h && h.status === "IN_PROGRESS") next = transitionHandoff(next, h.id, "REJECTED", { note: error.message }).data;
  }
  return { data: next, job: t.job, runs };
}

/** Human approves a job's output: job COMPLETED, artifact FINAL, handoff COMPLETED, task context cleared. */
export function approveJobOutput(data: OSData, jobId: string): { data: OSData; job: AgentJob } {
  const t = transitionJob(data, jobId, "COMPLETED");
  let next = t.data;
  const output = t.job.outputArtifactId ? next.artifacts.find((a) => a.id === t.job.outputArtifactId) : null;
  if (output && output.status !== "SUPERSEDED") next = setArtifactStatus(next, output.id, "FINAL");
  if (t.job.handoffId) {
    const h = next.handoffs.find((x) => x.id === t.job.handoffId);
    if (h && h.status === "IN_PROGRESS") next = transitionHandoff(next, h.id, "COMPLETED", { outputArtifactId: t.job.outputArtifactId }).data;
  }
  return { data: clearTaskKnowledge(next, jobId), job: t.job };
}

/** Human sends the output back: job re-queued, artifact stays DRAFT (a re-run produces the next version). */
export function requestJobRevision(data: OSData, jobId: string, note?: string): { data: OSData; job: AgentJob } {
  return transitionJob(data, jobId, "QUEUED", { error: note });
}

// ---------------------------------------------------------------------------
// Execution (async — the only impure step)
// ---------------------------------------------------------------------------

export interface ExecuteJobOutcome {
  data: OSData;
  job: AgentJob;
  runs: AgentRun[];
  artifactId: string | null;
  error: Error | null;
}

/** Start → route → apply. Never throws for provider failures; the failure is recorded on the job. */
export async function executeJob(data: OSData, jobId: string, router: ModelRouter, opts: ApplyResultOptions = {}): Promise<ExecuteJobOutcome> {
  const started = startJob(data, jobId);
  const request = buildProviderRequest(started.data, started.job);
  try {
    const result = await router.execute(started.job, request);
    const applied = applyJobResult(started.data, jobId, result, opts);
    return { data: applied.data, job: applied.job, runs: applied.runs, artifactId: applied.artifactId, error: null };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const failed = applyJobFailure(started.data, jobId, error);
    return { data: failed.data, job: failed.job, runs: failed.runs, artifactId: null, error };
  }
}

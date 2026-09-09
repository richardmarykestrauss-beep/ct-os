/**
 * Agent job / execution model.
 *
 * AgentJob is the standard contract for one unit of agent work. Each execution attempt on
 * a provider is an AgentRun. Jobs are executed through the ModelRouter; the results become
 * artifacts and handoffs. Functions are pure (OSData in → OSData out) except `executeJob`,
 * which awaits the router and then applies a pure result step.
 */
import type { Agent, AgentJob, AgentJobStatus, AgentRun, AgentTaskType, Artifact, ArtifactType, ExecutionLog, ExecutionPriority, Handoff, JobApproval, KnowledgeItem, OSData, Ticket } from "@/data/types";
import type { ModelRouter } from "@/ai/router";
import type { ApprovedKnowledge, ExecutionRequest, ProviderRequest, RouterAttempt, RouterResult } from "@/ai/types";
import { NoProviderAvailableError } from "@/ai/types";
import { isSchemaName, jsonSchemaFor, parseSchemaName } from "@/schemas/artifacts";
import { createArtifact, createArtifactVersion, latestArtifact, outputSchemaFor, setArtifactStatus } from "./artifacts";
import { createHandoff, transitionHandoff } from "./handoffs";
import { clearTaskKnowledge, knowledgeForJob } from "./knowledge";
import { approvedSkillsForAgent, type ActiveSkillRef } from "./skills";
import { estimateCostUsd, totalTokensOf } from "@/ai/pricing";
import { newId, nowIso } from "@/lib/core";

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
  requestedById?: string | null;
  /** Defaults to the agent's own `defaultPriority`, or "BALANCED" if the agent doesn't set one (CTOS-003 Part F). */
  executionPriority?: ExecutionPriority;
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
    executionPriority: input.executionPriority ?? agent.defaultPriority ?? "BALANCED",
    permissionLevel: agent.permissionLevel,
    status: "QUEUED",
    outputArtifactId: null,
    handoffId: null,
    requestedById: input.requestedById ?? null,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    completedAt: null,
  };
  return { data: { ...data, agentJobs: [...data.agentJobs, job] }, job };
}

/** Build a job from a ticket: consumes the latest artifacts the agent normally reads, records a handoff from their producer. */
export function createJobForTicket(data: OSData, ticket: Ticket, opts: { id?: string; handoffId?: string; at?: string; requestedById?: string | null } = {}): { data: OSData; job: AgentJob } {
  const agent = getAgent(data, ticket.agentId);
  const inputs = agent.consumesArtifactTypes.map((t) => latestArtifact(data, ticket.projectId, t)).filter((a): a is NonNullable<typeof a> => !!a);
  const instructions = [ticket.objective, ticket.scope.length ? `Scope: ${ticket.scope.join("; ")}` : null, ticket.doNotChange.length ? `Do not change: ${ticket.doNotChange.join("; ")}` : null]
    .filter(Boolean)
    .join("\n");
  let result = createJob(data, { id: opts.id, at: opts.at, requestedById: opts.requestedById, projectId: ticket.projectId, agentId: agent.id, ticketId: ticket.id, instructions, inputArtifactIds: inputs.map((a) => a.id) });
  // Handoff: from the producer of the primary input artifact (if any and if a different agent) to this agent.
  const primary = inputs.find((a) => a.createdByAgentId && a.createdByAgentId !== agent.id);
  if (primary?.createdByAgentId) {
    const h = createHandoff(result.data, {
      id: opts.handoffId,
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

/** Skill provenance shared by every run/log this execution produces — computed once by the caller (CTOS-003 Part L). */
export function runsFromAttempts(job: AgentJob, attempts: RouterAttempt[], result: RouterResult | null, existingCount: number, idFor: (i: number) => string = () => newId("run"), skillIds: string[] = []): AgentRun[] {
  return attempts.map((a, i) => ({
    id: idFor(i),
    jobId: job.id,
    projectId: job.projectId,
    agentId: job.agentId,
    providerId: a.providerId,
    model: a.model,
    attempt: existingCount + i + 1,
    status: a.outcome === "succeeded" ? "SUCCEEDED" : a.outcome === "failed" ? "FAILED" : a.outcome === "failed_validation" ? "FAILED_VALIDATION" : "SKIPPED",
    outputSummary: a.outcome === "succeeded" ? result?.response.summary : undefined,
    error: a.error,
    errorCategory: a.errorCategory,
    validation: a.validation,
    latencyMs: a.latencyMs,
    inputTokens: a.usage?.inputTokens ?? null,
    outputTokens: a.usage?.outputTokens ?? null,
    totalTokens: totalTokensOf(a.usage),
    estimatedCostUsd: estimateCostUsd(a.providerId, a.model, a.usage),
    selectionReason: a.selectionReason ?? null,
    skillIds,
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
  }));
}

// ---------------------------------------------------------------------------
// Execution envelope (Part C) — provider-neutral, approved knowledge only, scopes kept apart
// ---------------------------------------------------------------------------

const MAX_CONTENT_CHARS = 12_000;

function trimContent(content: unknown): unknown {
  if (content === undefined || content === null) return null;
  const json = JSON.stringify(content);
  return json.length <= MAX_CONTENT_CHARS ? content : { _truncated: true, preview: json.slice(0, MAX_CONTENT_CHARS) };
}

export function splitKnowledge(items: KnowledgeItem[]): ApprovedKnowledge {
  const pick = (scope: KnowledgeItem["scope"]) => items.filter((k) => k.status === "APPROVED" && k.scope === scope).map((k) => ({ id: k.id, title: k.title, content: k.content, category: k.category }));
  return { doctrine: pick("DOCTRINE"), agency: pick("AGENCY"), project: pick("PROJECT"), task: pick("TASK") };
}

export interface EnvelopeInputs {
  job: AgentJob;
  agent: Agent;
  inputArtifacts: Artifact[];
  /** Already filtered to APPROVED items relevant to the project/job. */
  knowledge: KnowledgeItem[];
  /** APPROVED skills only — see services/skills.ts#approvedSkillsForAgent. Defaults to none. */
  skills?: ActiveSkillRef[];
}

export function buildExecutionRequest({ job, agent, inputArtifacts, knowledge, skills = [] }: EnvelopeInputs): ExecutionRequest {
  return {
    jobId: job.id,
    projectId: job.projectId,
    agentId: job.agentId,
    agent: { code: agent.shortCode, name: agent.name, role: agent.role, responsibilities: agent.responsibilities },
    taskType: job.taskType,
    instructions: job.instructions,
    inputArtifacts: inputArtifacts.map((a) => ({ id: a.id, type: a.type, version: a.version, title: a.title, summary: a.summary ?? null, content: trimContent(a.content) })),
    approvedKnowledge: splitKnowledge(knowledge),
    availableTools: job.availableToolIds,
    requiredOutputSchema: job.requiredOutputSchema,
    schemaVersion: parseSchemaName(job.requiredOutputSchema).version,
    preferredProvider: job.preferredProvider,
    fallbackProviders: job.fallbackProviders,
    executionPriority: job.executionPriority ?? "BALANCED",
    requiredCapabilities: job.requiredCapabilities,
    permissionLevel: job.permissionLevel,
    requestedById: job.requestedById,
    activeSkills: skills,
  };
}

/** Build the envelope from an OSData snapshot (store / embedded gateway / tests). */
export function buildExecutionRequestFromData(data: OSData, job: AgentJob): ExecutionRequest {
  const agent = getAgent(data, job.agentId);
  const inputArtifacts = job.inputArtifactIds.map((id) => data.artifacts.find((a) => a.id === id)).filter((a): a is Artifact => !!a);
  const skills = approvedSkillsForAgent(data, job.agentId, agent.instructionPackIds ?? []);
  return buildExecutionRequest({ job, agent, inputArtifacts, knowledge: knowledgeForJob(data, job.projectId, job.id), skills });
}

/** Adds the assembled system context and output JSON schema. Sections are labelled so doctrine, agency patterns, project facts and skills never blur. */
export function toProviderRequest(req: ExecutionRequest): ProviderRequest {
  const k = req.approvedKnowledge;
  const section = (label: string, items: { title: string; content: string }[]) => (items.length ? `${label}:\n${items.map((i) => `- ${i.title}: ${i.content}`).join("\n")}` : `${label}: none`);
  const skillsSection = req.activeSkills.length
    ? `ACTIVE SKILLS (approved only — v${req.activeSkills.map((s) => s.version).join(", v")}):\n${req.activeSkills.map((s) => `- ${s.name} (v${s.version}): ${s.content}`).join("\n")}`
    : "ACTIVE SKILLS: none";
  const systemContext = [
    `You are ${req.agent.code} ${req.agent.name} — ${req.agent.role}, an agent of Creative Touch Website OS. Responsibilities: ${req.agent.responsibilities.join(", ")}.`,
    `Permission level for this job: ${req.permissionLevel}. You may not exceed it. You never mutate live systems yourself; you produce a structured artifact for human review.`,
    section("DOCTRINE (permanent Creative Touch rules)", k.doctrine),
    section("AGENCY KNOWLEDGE (validated patterns)", k.agency),
    section("PROJECT FACTS (this client/project only)", k.project),
    section("TASK CONTEXT (this job only)", k.task),
    skillsSection,
    `Output contract: return exactly one JSON object satisfying "${req.requiredOutputSchema}".`,
  ].join("\n\n");
  return { ...req, systemContext, outputJsonSchema: isSchemaName(req.requiredOutputSchema) ? jsonSchemaFor(req.requiredOutputSchema) : null };
}

/** @deprecated CTOS-001 name — kept for callers/tests; same as toProviderRequest(buildExecutionRequestFromData()). */
export function buildProviderRequest(data: OSData, job: AgentJob): ProviderRequest {
  return toProviderRequest(buildExecutionRequestFromData(data, job));
}

// ---------------------------------------------------------------------------
// Result application (pure)
// ---------------------------------------------------------------------------

export interface ApplyResultOptions {
  artifactTitle?: string;
  /** When true (default) the job pauses in WAITING_APPROVAL; a human completes it. */
  requiresApproval?: boolean;
  runIdFor?: (i: number) => string;
  artifactId?: string;
}

/** Record runs, create the output artifact from the VALIDATED output (new version if one exists for the lineage), advance job + handoff. */
export function applyJobResult(data: OSData, jobId: string, result: RouterResult, opts: ApplyResultOptions = {}): { data: OSData; job: AgentJob; runs: AgentRun[]; artifactId: string } {
  const job = data.agentJobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status !== "RUNNING") throw new JobStateError(`Job ${jobId} is ${job.status}, expected RUNNING`);
  if (!result.validation.ok) throw new JobStateError("applyJobResult requires a validated result");
  const existingRuns = data.agentRuns.filter((r) => r.jobId === jobId).length;
  const runs = runsFromAttempts(job, result.attempts, result, existingRuns, opts.runIdFor);
  let next: OSData = { ...data, agentRuns: [...data.agentRuns, ...runs] };

  const type = parseSchemaName(job.requiredOutputSchema).type;
  const previous = job.ticketId ? next.artifacts.find((a) => a.jobId && a.type === type && a.projectId === job.projectId && a.ticketId === job.ticketId && a.status !== "SUPERSEDED") : null;
  const title = opts.artifactTitle ?? `${type.replace(/_/g, " ")} — ${job.taskType}`;
  const created = previous
    ? createArtifactVersion(next, { previousArtifactId: previous.id, createdByAgentId: job.agentId, createdByProvider: result.providerId, jobId: job.id, ticketId: job.ticketId, summary: result.response.summary, content: result.output, id: opts.artifactId })
    : createArtifact(next, { projectId: job.projectId, type, title, createdByAgentId: job.agentId, createdByProvider: result.providerId, jobId: job.id, ticketId: job.ticketId, summary: result.response.summary, content: result.output, id: opts.artifactId });
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

export function applyJobFailure(data: OSData, jobId: string, error: NoProviderAvailableError | Error, opts: { runIdFor?: (i: number) => string } = {}): { data: OSData; job: AgentJob; runs: AgentRun[] } {
  const job = data.agentJobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  const attempts = error instanceof NoProviderAvailableError ? error.attempts : [];
  const existingRuns = data.agentRuns.filter((r) => r.jobId === jobId).length;
  const runs = runsFromAttempts(job, attempts, null, existingRuns, opts.runIdFor);
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
// Gateway records — what an execution produced, applied identically on server and client
// ---------------------------------------------------------------------------

export interface GatewayRecords {
  job: AgentJob;
  runs: AgentRun[];
  artifact: Artifact | null;
  supersededArtifactId: string | null;
  handoff: Handoff | null;
  approval: JobApproval | null;
  logs: ExecutionLog[];
}

/** Merge gateway-produced records into a snapshot (upsert by id). Pure. */
export function applyGatewayRecords(data: OSData, records: GatewayRecords): OSData {
  const upsert = <T extends { id: string }>(list: T[], item: T | null): T[] => (item ? (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]) : list);
  let next: OSData = { ...data };
  next = { ...next, agentJobs: upsert(next.agentJobs, records.job) };
  for (const r of records.runs) next = { ...next, agentRuns: upsert(next.agentRuns, r) };
  if (records.supersededArtifactId) next = { ...next, artifacts: next.artifacts.map((a) => (a.id === records.supersededArtifactId ? { ...a, status: "SUPERSEDED", updatedAt: records.artifact?.createdAt ?? a.updatedAt } : a)) };
  next = { ...next, artifacts: upsert(next.artifacts, records.artifact) };
  next = { ...next, handoffs: upsert(next.handoffs, records.handoff) };
  next = { ...next, jobApprovals: upsert(next.jobApprovals, records.approval) };
  for (const l of records.logs) next = { ...next, executionLogs: upsert(next.executionLogs, l) };
  return next;
}

// ---------------------------------------------------------------------------
// Direct execution (tests / embedded convenience) — the gateway is the production path
// ---------------------------------------------------------------------------

export interface ExecuteJobOutcome {
  data: OSData;
  job: AgentJob;
  runs: AgentRun[];
  artifactId: string | null;
  error: Error | null;
}

/** Start → route → validate → apply. Never throws for provider failures; the failure is recorded on the job. */
export async function executeJob(data: OSData, jobId: string, router: ModelRouter, opts: ApplyResultOptions = {}): Promise<ExecuteJobOutcome> {
  const started = startJob(data, jobId);
  const request = buildProviderRequest(started.data, started.job);
  try {
    const result = await router.execute(request);
    const applied = applyJobResult(started.data, jobId, result, opts);
    return { data: applied.data, job: applied.job, runs: applied.runs, artifactId: applied.artifactId, error: null };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const failed = applyJobFailure(started.data, jobId, error);
    return { data: failed.data, job: failed.job, runs: failed.runs, artifactId: null, error };
  }
}

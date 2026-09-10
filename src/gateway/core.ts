/**
 * Execution gateway core — runtime-neutral (browser, Node, Deno).
 *
 * POST /agent-execute:
 *   verify session → load server-side job truth → enforce permission tier → build the neutral
 *   envelope from APPROVED knowledge only → ModelRouter (with structured validation + fallback)
 *   → runs, artifact, handoff, approval consumption, execution logs → commit → respond.
 *
 * Nothing here reads a provider secret; the registry passed in already holds the adapters.
 * Nothing here logs tokens or keys. Responses carry records so the client can mirror them.
 */
import type { AgentJob, AuthUser, ExecutionLog, ValidationResult } from "@/data/types";
import { ModelRouter } from "@/ai/router";
import { NoProviderAvailableError, type ExecutionResult, type RouterAttempt, type RouterResult } from "@/ai/types";
import { buildExecutionRequest, toProviderRequest, transitionJob, runsFromAttempts, MAX_AUTO_RETRY_ATTEMPTS, type GatewayRecords } from "@/services/agent-jobs";
import { createArtifact, createArtifactVersion } from "@/services/artifacts";
import { checkPermission, effectiveLevel, type PermissionCheck } from "@/services/job-approvals";
import { skillProvenance } from "@/services/skills";
import { estimateCostUsd, totalTokensOf } from "@/ai/pricing";
import { parseSchemaName } from "@/schemas/artifacts";
import type { ProviderStatus } from "@/ai/registry";
import type { GatewayStore, JobContext } from "./store";
import type { OSData } from "@/data/types";

export interface GatewayAuth {
  /** Resolve a bearer token to a user, or null when invalid/expired. Never throws for bad tokens. */
  verify(token: string | null): Promise<AuthUser | null>;
}

export interface GatewayDeps {
  auth: GatewayAuth;
  store: GatewayStore;
  router: ModelRouter;
  /** "supabase" (server) or "local" (embedded, stubs only). Reported in health, never trusted for security. */
  mode: "supabase" | "local";
  newId?: (prefix: string) => string;
  now?: () => string;
  /** Structured, secret-free log sink. */
  log?: (event: Record<string, unknown>) => void;
}

export interface ExecuteInput {
  token: string | null;
  jobId: string;
  /** Optional artifact title hint from the client (display only). */
  artifactTitle?: string;
}

export type GatewayErrorCode = "unauthenticated" | "forbidden" | "not_found" | "invalid_state" | "bad_request" | "internal";

export interface GatewayFailure {
  ok: false;
  code: GatewayErrorCode;
  message: string;
  permission?: PermissionCheck;
  status: number;
}

export interface GatewaySuccess {
  ok: true;
  result: ExecutionResult;
  records: GatewayRecords;
  permission: PermissionCheck;
  status: 200;
}

export type GatewayResponse = GatewaySuccess | GatewayFailure;

export interface HealthResponse {
  ok: true;
  mode: GatewayDeps["mode"];
  providers: ProviderStatus[];
  user: { id: string; displayName: string; role: AuthUser["role"] };
}

const defaultNewId = (prefix: string) => `${prefix}_${(globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

export async function handleHealth(input: { token: string | null }, deps: GatewayDeps): Promise<HealthResponse | GatewayFailure> {
  const user = await deps.auth.verify(input.token);
  if (!user) return fail("unauthenticated", "Sign in to use the execution gateway", 401);
  return { ok: true, mode: deps.mode, providers: await deps.router.status(), user: { id: user.id, displayName: user.displayName, role: user.role } };
}

export async function handleExecute(input: ExecuteInput, deps: GatewayDeps): Promise<GatewayResponse> {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? defaultNewId;
  const log = deps.log ?? (() => undefined);

  // 1. Identity — a missing or invalid session is rejected before anything is read.
  const user = await deps.auth.verify(input.token);
  if (!user) return fail("unauthenticated", "Sign in to use the execution gateway", 401);
  if (!input.jobId || typeof input.jobId !== "string") return fail("bad_request", "jobId is required", 400);

  // 2. Server-side truth.
  const ctx = await deps.store.loadJobContext(input.jobId);
  if (!ctx) return fail("not_found", `Job ${input.jobId} not found`, 404);
  const { job } = ctx;
  if (job.status !== "QUEUED" && job.status !== "RUNNING") return fail("invalid_state", `Job is ${job.status}; only QUEUED or RUNNING jobs can execute`, 409);

  // One execution at a time per job (lease), so a double click or two tabs cannot double-run,
  // double-version the artifact or consume the same approval twice.
  const claimId = newId("claim");
  if (!(await deps.store.claimJob(job.id, claimId, LEASE_MS))) return fail("invalid_state", "Job is already being executed", 409);
  try {
    return await executeClaimed(input, deps, ctx, user, claimId, now, newId, log);
  } catch (err) {
    await deps.store.releaseJob(job.id, claimId).catch(() => undefined);
    throw err;
  }
}

const LEASE_MS = 10 * 60 * 1000;

async function executeClaimed(input: ExecuteInput, deps: GatewayDeps, ctx: JobContext, user: AuthUser, claimId: string, now: () => string, newId: (p: string) => string, log: NonNullable<GatewayDeps["log"]>): Promise<GatewayResponse> {
  const { job, agent } = ctx;
  // 3. Permission enforcement (Part F). The AGENT's tier (ADMIN-only to edit) is the floor; a job may
  //    only ever raise it. A lowered job tier written by a client is ignored.
  const level = effectiveLevel(job.permissionLevel, agent.permissionLevel);
  const roleCache = new Map<string, AuthUser["role"] | null>();
  const approverRole = (id: string) => roleCache.get(id) ?? null;
  for (const a of ctx.approvals) if (a.approvedById && !roleCache.has(a.approvedById)) roleCache.set(a.approvedById, await deps.store.getUserRole(a.approvedById));
  if (!roleCache.has(user.id)) roleCache.set(user.id, (await deps.store.getUserRole(user.id)) ?? user.role);
  const permission = checkPermission({ level, user, job, approvals: ctx.approvals, approverRole: (id) => approverRole(id) ?? (id === user.id ? user.role : null), now: now() });
  if (permission.outcome === "denied") {
    const rejected: ExecutionLog = baseLog(ctx, newId, now(), user, permission, { status: "REJECTED", fallbackIndex: 0, errorCategory: "permission_denied", errorMessage: permission.reason });
    await deps.store.commit({ job, runs: [], artifact: null, supersededArtifactId: null, handoff: null, approval: null, logs: [rejected] });
    log({ event: "execute.denied", jobId: job.id, agent: agent.code, userId: user.id, level, reason: permission.reason });
    return { ...fail("forbidden", permission.reason, 403), permission };
  }
  void claimId;

  // 4. Envelope from approved knowledge and APPROVED skills only, then route.
  const startedAt = now();
  const running = job.status === "RUNNING" ? job : transitionJob(snapshotWithJob(job), job.id, "RUNNING").job;
  const request = toProviderRequest(buildExecutionRequest({ job: running, agent, inputArtifacts: ctx.inputArtifacts, knowledge: ctx.knowledge, skills: ctx.activeSkills }));
  const skillIds = skillProvenance(ctx.activeSkills);
  log({ event: "execute.start", jobId: job.id, agent: agent.code, userId: user.id, level, preferred: job.preferredProvider, fallbacks: job.fallbackProviders, schema: job.requiredOutputSchema, priority: request.executionPriority, skillIds });

  let routerResult: RouterResult | null = null;
  let failure: NoProviderAvailableError | Error | null = null;
  try {
    routerResult = await deps.router.execute(request);
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  }

  // 5. Records.
  const attempts = routerResult ? routerResult.attempts : failure instanceof NoProviderAvailableError ? failure.attempts : [];
  const runs = runsFromAttempts(running, attempts, routerResult, ctx.existingRunCount, () => newId("run"), skillIds);
  const logs = attempts.map((a, i) => attemptLog(ctx, newId, user, permission, a, runs[i]?.id ?? null, i, skillIds));

  if (routerResult) {
    const type = parseSchemaName(job.requiredOutputSchema).type;
    const artifactId = newId("art");
    const title = input.artifactTitle ?? `${type.replace(/_/g, " ")} — ${job.taskType}`;
    // Build the artifact with the pure helpers over a minimal snapshot (previous version included).
    const seedData = minimalSnapshot(running, ctx);
    const created = ctx.previousOutput
      ? createArtifactVersion(seedData, { previousArtifactId: ctx.previousOutput.id, createdByAgentId: job.agentId, createdByProvider: routerResult.providerId, jobId: job.id, ticketId: job.ticketId, summary: routerResult.response.summary, content: routerResult.output, id: artifactId, at: now() })
      : createArtifact(seedData, { projectId: job.projectId, type, title, createdByAgentId: job.agentId, createdByProvider: routerResult.providerId, jobId: job.id, ticketId: job.ticketId, summary: routerResult.response.summary, content: routerResult.output, id: artifactId, at: now() });
    const successfulRun = runs.find((r) => r.status === "SUCCEEDED") ?? null;
    const updatedJob = transitionJob(seedData, job.id, "WAITING_APPROVAL", { outputArtifactId: created.artifact.id, error: undefined }).job;
    const handoff = ctx.handoff ? { ...ctx.handoff, status: ctx.handoff.status === "ACCEPTED" || ctx.handoff.status === "IN_PROGRESS" ? ("IN_PROGRESS" as const) : ctx.handoff.status, outputArtifactId: created.artifact.id, runId: successfulRun?.id ?? null, updatedAt: now() } : null;
    const approval = permission.approvalId ? (ctx.approvals.find((a) => a.id === permission.approvalId) ?? null) : null;
    const consumed = approval && approval.status === "APPROVED" ? { ...approval, status: "CONSUMED" as const, consumedAt: now() } : null;
    const successIndex = attempts.findIndex((a) => a.outcome === "succeeded");
    if (successIndex >= 0) logs[successIndex] = { ...logs[successIndex], artifactId: created.artifact.id, status: "COMPLETED" };
    const records: GatewayRecords = { job: updatedJob, runs, artifact: created.artifact, supersededArtifactId: ctx.previousOutput?.id ?? null, handoff, approval: consumed, logs };
    await deps.store.commit(records);
    const a = attempts[successIndex];
    log({ event: "execute.completed", jobId: job.id, agent: agent.code, provider: routerResult.providerId, model: routerResult.response.model, attempts: attempts.length, artifactId: created.artifact.id });
    const result: ExecutionResult = {
      provider: routerResult.providerId,
      model: routerResult.response.model,
      runId: successfulRun?.id ?? null,
      status: "COMPLETED",
      output: routerResult.output,
      outputSchema: job.requiredOutputSchema,
      schemaVersion: request.schemaVersion,
      usage: routerResult.response.usage,
      latencyMs: a?.latencyMs ?? null,
      finishReason: routerResult.response.finishReason,
      error: null,
      attempts,
    };
    // Per-attempt usage totals/estimated cost are recorded on runs and execution logs (see
    // runsFromAttempts/attemptLog below); ExecutionResult.usage stays the raw provider figures.
    return { ok: true, result, records, permission, status: 200 };
  }

  // Failure path: after MAX_AUTO_RETRY_ATTEMPTS total attempts → NEEDS_A_HAND; else FAILED.
  // Provider exhaustion must result in an explicit actionable state, not silent FAILED.
  const err = failure!;
  const totalAttempts = attempts.length;
  const targetStatus = totalAttempts >= MAX_AUTO_RETRY_ATTEMPTS ? "NEEDS_A_HAND" : "FAILED";
  const failedJob = transitionJob(snapshotWithJob(running), job.id, targetStatus, { error: err.message }).job;
  const handoff = ctx.handoff && (ctx.handoff.status === "ACCEPTED" || ctx.handoff.status === "IN_PROGRESS") ? { ...ctx.handoff, status: "REJECTED" as const, note: err.message, updatedAt: now() } : null;
  const logStatus = targetStatus === "NEEDS_A_HAND" ? "FAILED" : "FAILED"; // log always uses FAILED category
  const records: GatewayRecords = { job: failedJob, runs, artifact: null, supersededArtifactId: null, handoff, approval: null, logs: logs.length ? logs : [baseLog(ctx, newId, startedAt, user, permission, { status: logStatus, fallbackIndex: 0, errorCategory: "internal", errorMessage: err.message })] };
  await deps.store.commit(records);
  const lastValidation = [...attempts].reverse().find((a) => a.outcome === "failed_validation");
  log({ event: targetStatus === "NEEDS_A_HAND" ? "execute.needs_a_hand" : "execute.failed", jobId: job.id, agent: agent.code, attempts: attempts.length, error: err.message });
  const result: ExecutionResult = {
    provider: null,
    model: null,
    runId: null,
    status: lastValidation && attempts.every((a) => a.outcome !== "failed") ? "FAILED_VALIDATION" : "FAILED",
    output: null,
    outputSchema: job.requiredOutputSchema,
    schemaVersion: request.schemaVersion,
    usage: { inputTokens: null, outputTokens: null },
    latencyMs: null,
    finishReason: null,
    error: lastValidation
      ? { category: "validation", message: lastValidation.error ?? "Output failed validation", issues: lastValidation.validation?.issues }
      : { category: attempts.length && attempts.every((a) => a.outcome === "skipped") ? "provider_unavailable" : "provider_error", message: err.message },
    attempts,
  };
  return { ok: true, result, records, permission, status: 200 };
}

// ---------------------------------------------------------------------------

function fail(code: GatewayErrorCode, message: string, status: number): GatewayFailure {
  return { ok: false, code, message, status };
}

function snapshotWithJob(job: AgentJob): OSData {
  return { ...EMPTY, agentJobs: [job] };
}

function minimalSnapshot(job: AgentJob, ctx: JobContext): OSData {
  return { ...EMPTY, agentJobs: [job], artifacts: ctx.previousOutput ? [ctx.previousOutput] : [], handoffs: ctx.handoff ? [ctx.handoff] : [] };
}

export const EMPTY: OSData = {
  clients: [], projects: [], phases: [], agents: [], pages: [], tickets: [], artifacts: [], qaItems: [], qaRuns: [], launchHolds: [], approvals: [], gates: [], activity: [],
  agentJobs: [], agentRuns: [], handoffs: [], knowledgeItems: [], agentLessons: [], integrations: [], projectIntegrations: [], jobApprovals: [], executionLogs: [], skills: [], externalClients: [], externalAccessLog: [],
  buildPacks: [], revisionRounds: [], changeRequests: [], clientAssets: [], curationCandidates: [], screenshotEvidence: [], modeBJobs: [],
  visualReferences: [], signatureVisualElements: [], sectionLibrary: [], designTokenSets: [], visualDefects: [], designContentReconciliations: [],
  // CTOS-006: WordPress Write Engine
  wpSiteConnections: [], websiteChangePlans: [], websiteRevisionSnapshots: [], websiteWriteResults: [], wpWriteAuditLog: [], wpIdempotencyLog: [],
};

function baseLog(ctx: JobContext, newId: (p: string) => string, at: string, user: AuthUser, permission: PermissionCheck, patch: Partial<ExecutionLog>): ExecutionLog {
  return {
    id: newId("xlog"),
    jobId: ctx.job.id,
    runId: null,
    projectId: ctx.job.projectId,
    agentId: ctx.job.agentId,
    providerId: null,
    model: null,
    status: "FAILED",
    fallbackIndex: 0,
    permissionCheck: { level: permission.level, outcome: permission.outcome, reason: permission.reason, approvalId: permission.approvalId },
    validation: null,
    artifactId: null,
    errorCategory: null,
    errorMessage: null,
    usage: null,
    latencyMs: null,
    requestedById: user.id,
    rawOutput: null,
    startedAt: at,
    finishedAt: at,
    ...patch,
  };
}

function attemptLog(ctx: JobContext, newId: (p: string) => string, user: AuthUser, permission: PermissionCheck, a: RouterAttempt, runId: string | null, index: number, skillIds: string[] = []): ExecutionLog {
  const validation: ValidationResult | null = a.validation;
  return baseLog(ctx, newId, a.startedAt, user, permission, {
    runId,
    providerId: a.providerId,
    model: a.model,
    status: a.outcome === "succeeded" ? "COMPLETED" : a.outcome === "failed_validation" ? "FAILED_VALIDATION" : a.outcome === "skipped" ? "SKIPPED" : "FAILED",
    fallbackIndex: index,
    validation,
    errorCategory: a.errorCategory,
    errorMessage: a.error ?? null,
    usage: a.usage ? { ...a.usage, totalTokens: totalTokensOf(a.usage), estimatedCostUsd: estimateCostUsd(a.providerId, a.model, a.usage) } : null,
    latencyMs: a.latencyMs,
    // Raw output is kept only when validation failed, so the failure can be diagnosed.
    rawOutput: a.outcome === "failed_validation" ? (a.rawOutput ?? null) : null,
    selectionReason: a.selectionReason ?? null,
    skillIds,
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
  });
}

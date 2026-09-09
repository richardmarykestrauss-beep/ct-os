/**
 * CTOS-004 Part B — read-only MCP tools. Every one of these is `ceiling: "READ_ONLY"`, meaning
 * even a client with no write privileges at all may call them. None of them ever mutates OSData;
 * each simply projects a slice of it into a small, MCP-friendly shape.
 */
import { z } from "zod";
import { readOnly, trimForTransport, type McpToolDef } from "../types";

const projectSummary = (p: import("@/data/types").Project) => ({
  id: p.id,
  clientId: p.clientId,
  name: p.name,
  type: p.type,
  state: p.state,
  statusLabel: p.statusLabel,
  progress: p.progress,
  currentPhase: p.currentPhase,
  nextAction: p.nextAction,
  domain: p.domain ?? null,
  updatedAt: p.updatedAt,
});

const systemStatus = readOnly({
  name: "ctos.system.status",
  title: "CT-OS system status",
  description: "High-level CT-OS health: project/ticket/approval counts and intelligence provider availability (no credentials, ever).",
  schema: z.object({}),
  handler: async (ctx) => {
    const d = ctx.store.data;
    const providers = await ctx.registry.status();
    const result = {
      projects: d.projects.length,
      activeProjects: d.projects.filter((p) => p.state !== "ARCHIVED").length,
      openTickets: d.tickets.filter((t) => t.status !== "COMPLETE" && t.status !== "BLOCKED").length,
      pendingGateApprovals: d.approvals.filter((a) => a.status === "PENDING").length,
      pendingJobApprovals: d.jobApprovals.filter((a) => a.status === "PENDING").length,
      openLaunchHolds: d.launchHolds.filter((h) => !h.resolved).length,
      agentJobsByStatus: countBy(d.agentJobs, (j) => j.status),
      providers: providers.map((p) => ({ id: p.id, label: p.label, state: p.state, available: p.available })),
    };
    return { result, requestedAction: "read system status" };
  },
});

const projectsList = readOnly({
  name: "ctos.projects.list",
  title: "List projects",
  description: "List every CT-OS project with its state, progress and next action.",
  schema: z.object({}),
  handler: (ctx) => ({ result: ctx.store.data.projects.map(projectSummary), requestedAction: "list projects" }),
});

const projectsGet = readOnly({
  name: "ctos.projects.get",
  title: "Get project",
  description: "Full detail for one project: client, phases, platforms, goal and notes.",
  schema: z.object({ projectId: z.string().min(1) }),
  handler: (ctx, { projectId }) => {
    const d = ctx.store.data;
    const project = d.projects.find((p) => p.id === projectId);
    if (!project) return { result: { ok: false, error: `project ${projectId} not found` }, requestedAction: `get project ${projectId}`, projectId };
    const client = d.clients.find((c) => c.id === project.clientId) ?? null;
    const phases = d.phases.filter((ph) => ph.projectId === projectId).sort((a, b) => a.order - b.order);
    return {
      result: { ...projectSummary(project), platforms: project.platforms, platformSummary: project.platformSummary, primaryGoal: project.primaryGoal ?? null, notes: project.notes ?? null, client: client ? { id: client.id, name: client.name, websiteUrl: client.websiteUrl ?? null } : null, phases: phases.map((ph) => ({ key: ph.key, label: ph.label, status: ph.status, order: ph.order, note: ph.note ?? null })) },
      requestedAction: `get project ${projectId}`,
      projectId,
    };
  },
});

const projectTimeline = readOnly({
  name: "ctos.project.timeline",
  title: "Project timeline",
  description: "Recent activity events for a project (state changes, approvals, QA, artifacts, jobs), newest first.",
  schema: z.object({ projectId: z.string().min(1), limit: z.number().int().min(1).max(200).optional() }),
  handler: (ctx, { projectId, limit = 50 }) => {
    const events = ctx.store.data.activity
      .filter((a) => a.projectId === projectId)
      .sort((a, b) => b.order - a.order)
      .slice(0, limit)
      .map((a) => ({ kind: a.kind, ref: a.ref ?? null, message: a.message, actor: a.actor, at: a.at }));
    return { result: events, requestedAction: `read timeline for project ${projectId}`, projectId };
  },
});

const ticketsList = readOnly({
  name: "ctos.tickets.list",
  title: "List tickets",
  description: "List tickets, optionally filtered by project and/or status.",
  schema: z.object({ projectId: z.string().optional(), status: z.enum(["QUEUED", "READY", "BUILDING", "REVIEW", "COMPLETE", "BLOCKED"]).optional() }),
  handler: (ctx, { projectId, status }) => {
    const tickets = ctx.store.data.tickets
      .filter((t) => (!projectId || t.projectId === projectId) && (!status || t.status === status))
      .map((t) => ({ id: t.id, code: t.code, projectId: t.projectId, title: t.title, agentId: t.agentId, phase: t.phase, status: t.status, priority: t.priority, approvalState: t.approvalState, updatedAt: t.updatedAt }));
    return { result: tickets, requestedAction: `list tickets${projectId ? ` for project ${projectId}` : ""}`, projectId: projectId ?? null };
  },
});

const ticketsGet = readOnly({
  name: "ctos.tickets.get",
  title: "Get ticket",
  description: "Full detail for one ticket: objective, scope, do-not-change list, warnings and safety check.",
  schema: z.object({ ticketId: z.string().min(1) }),
  handler: (ctx, { ticketId }) => {
    const t = ctx.store.data.tickets.find((x) => x.id === ticketId);
    if (!t) return { result: { ok: false, error: `ticket ${ticketId} not found` }, requestedAction: `get ticket ${ticketId}` };
    return { result: t, requestedAction: `get ticket ${t.code}`, projectId: t.projectId };
  },
});

const artifactsList = readOnly({
  name: "ctos.artifacts.list",
  title: "List artifacts",
  description: "List artifacts (metadata only, no content), optionally filtered by project, type or status.",
  schema: z.object({ projectId: z.string().optional(), type: z.string().optional(), status: z.enum(["DRAFT", "FINAL", "SUPERSEDED", "REJECTED"]).optional() }),
  handler: (ctx, { projectId, type, status }) => {
    const artifacts = ctx.store.data.artifacts
      .filter((a) => (!projectId || a.projectId === projectId) && (!type || a.type === type) && (!status || a.status === status))
      .map((a) => ({ id: a.id, projectId: a.projectId, type: a.type, title: a.title, version: a.version, status: a.status, createdByAgentId: a.createdByAgentId, createdByProvider: a.createdByProvider, summary: a.summary ?? null, updatedAt: a.updatedAt }));
    return { result: artifacts, requestedAction: `list artifacts${projectId ? ` for project ${projectId}` : ""}`, projectId: projectId ?? null };
  },
});

const artifactsGet = readOnly({
  name: "ctos.artifacts.get",
  title: "Get artifact",
  description: "Full detail for one artifact, including its (size-capped) structured content.",
  schema: z.object({ artifactId: z.string().min(1) }),
  handler: (ctx, { artifactId }) => {
    const a = ctx.store.data.artifacts.find((x) => x.id === artifactId);
    if (!a) return { result: { ok: false, error: `artifact ${artifactId} not found` }, requestedAction: `get artifact ${artifactId}` };
    return { result: { ...a, content: trimForTransport(a.content) }, requestedAction: `get artifact ${a.title} v${a.version}`, projectId: a.projectId };
  },
});

const agentsList = readOnly({
  name: "ctos.agents.list",
  title: "List agents",
  description: "List every CT-OS agent with role, status, permission tier and provider policy.",
  schema: z.object({}),
  handler: (ctx) => ({
    result: ctx.store.data.agents.map((a) => ({ id: a.id, code: a.code, shortCode: a.shortCode, name: a.name, role: a.role, status: a.status, statusDetail: a.statusDetail ?? null, permissionLevel: a.permissionLevel, providerPolicy: a.providerPolicy, currentProjectId: a.currentProjectId ?? null, canExecuteSiteChanges: a.canExecuteSiteChanges })),
    requestedAction: "list agents",
  }),
});

const agentRuns = readOnly({
  name: "ctos.agent.runs",
  title: "Agent execution runs",
  description: "Recent provider execution attempts (runs), optionally filtered by agent or job.",
  schema: z.object({ agentId: z.string().optional(), jobId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
  handler: (ctx, { agentId, jobId, limit = 50 }) => {
    const runs = ctx.store.data.agentRuns
      .filter((r) => (!agentId || r.agentId === agentId) && (!jobId || r.jobId === jobId))
      .slice(-limit)
      .reverse()
      .map((r) => ({ id: r.id, jobId: r.jobId, agentId: r.agentId, providerId: r.providerId, model: r.model, attempt: r.attempt, status: r.status, error: r.error ?? null, errorCategory: r.errorCategory, totalTokens: r.totalTokens ?? null, estimatedCostUsd: r.estimatedCostUsd ?? null, startedAt: r.startedAt, finishedAt: r.finishedAt }));
    return { result: runs, requestedAction: "list agent runs", projectId: null };
  },
});

const qaStatus = readOnly({
  name: "ctos.qa.status",
  title: "QA status",
  description: "QA runs and open defect counts by severity for a project.",
  schema: z.object({ projectId: z.string().min(1) }),
  handler: (ctx, { projectId }) => {
    const d = ctx.store.data;
    const items = d.qaItems.filter((q) => q.projectId === projectId);
    const open = items.filter((q) => q.status === "OPEN" || q.status === "IN_PROGRESS");
    const runs = d.qaRuns.filter((r) => r.projectId === projectId).slice(-10).reverse();
    return {
      result: {
        openBySeverity: { P0: open.filter((q) => q.severity === "P0").length, P1: open.filter((q) => q.severity === "P1").length, P2: open.filter((q) => q.severity === "P2").length, P3: open.filter((q) => q.severity === "P3").length },
        latestRun: runs[0] ? { id: runs[0].id, result: runs[0].result, counts: runs[0].counts, summary: runs[0].summary ?? null, finishedAt: runs[0].finishedAt } : null,
        recentRuns: runs.map((r) => ({ id: r.id, result: r.result, counts: r.counts, finishedAt: r.finishedAt })),
      },
      requestedAction: `read QA status for project ${projectId}`,
      projectId,
    };
  },
});

const approvalsPending = readOnly({
  name: "ctos.approvals.pending",
  title: "Pending approvals",
  description: "Every approval awaiting a human decision - project gate approvals and AMBER job approvals alike.",
  schema: z.object({}),
  handler: (ctx) => {
    const d = ctx.store.data;
    const gates = d.approvals.filter((a) => a.status === "PENDING").map((a) => ({ kind: "gate" as const, id: a.id, projectId: a.projectId, gate: a.gate, requestedBy: a.requestedBy, createdAt: a.createdAt }));
    const jobs = d.jobApprovals.filter((a) => a.status === "PENDING").map((a) => ({ kind: "job" as const, id: a.id, projectId: a.projectId, jobId: a.jobId, permissionLevel: a.permissionLevel, requestedAction: a.requestedAction, requestedByName: a.requestedByName, createdAt: a.createdAt }));
    return { result: { gateApprovals: gates, jobApprovals: jobs }, requestedAction: "list pending approvals" };
  },
});

const launchHoldsList = readOnly({
  name: "ctos.launch_holds.list",
  title: "List launch holds",
  description: "Launch holds (things that must be resolved before a project may go live), optionally filtered by project or resolved state.",
  schema: z.object({ projectId: z.string().optional(), resolved: z.boolean().optional() }),
  handler: (ctx, { projectId, resolved }) => {
    const holds = ctx.store.data.launchHolds
      .filter((h) => (!projectId || h.projectId === projectId) && (resolved === undefined || h.resolved === resolved))
      .map((h) => ({ id: h.id, projectId: h.projectId, title: h.title, detail: h.detail ?? null, owner: h.owner, resolved: h.resolved, createdAt: h.createdAt }));
    return { result: holds, requestedAction: `list launch holds${projectId ? ` for project ${projectId}` : ""}`, projectId: projectId ?? null };
  },
});

const knowledgeSearch = readOnly({
  name: "ctos.knowledge.search",
  title: "Search knowledge",
  description: "Search APPROVED CT-OS knowledge by title/content. Only a GREEN_WRITE-ceiling client may set includeCandidates to also see unreviewed CANDIDATE proposals.",
  schema: z.object({ query: z.string().min(1), scope: z.enum(["DOCTRINE", "AGENCY", "PROJECT", "TASK"]).optional(), includeCandidates: z.boolean().optional() }),
  handler: (ctx, { query, scope, includeCandidates }) => {
    const q = query.toLowerCase();
    const allowCandidates = !!includeCandidates && ctx.client.permissionCeiling === "GREEN_WRITE";
    const items = ctx.store.data.knowledgeItems.filter((k) => {
      if (k.status !== "APPROVED" && !(allowCandidates && k.status === "CANDIDATE")) return false;
      if (scope && k.scope !== scope) return false;
      return k.title.toLowerCase().includes(q) || k.content.toLowerCase().includes(q);
    });
    return {
      result: items.slice(0, 25).map((k) => ({ id: k.id, scope: k.scope, category: k.category, title: k.title, content: k.content, status: k.status, projectId: k.projectId })),
      requestedAction: `search knowledge for "${query}"`,
    };
  },
});

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export const READ_TOOLS: McpToolDef<any>[] = [systemStatus, projectsList, projectsGet, projectTimeline, ticketsList, ticketsGet, artifactsList, artifactsGet, agentsList, agentRuns, qaStatus, approvalsPending, launchHoldsList, knowledgeSearch];

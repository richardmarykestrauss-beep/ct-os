/**
 * CTOS-004 Part C — safe write tools. All six are `ceiling: "GREEN_WRITE"`: a READ_ONLY client
 * cannot call any of them (the registry wrapper enforces this before a handler ever runs).
 *
 * None of these tools ever executes a RED action, self-approves an AMBER request, or produces
 * anything other than a CANDIDATE knowledge proposal - those guarantees come from the existing
 * service functions themselves (services/knowledge.ts#createKnowledgeItem forces CANDIDATE for a
 * non-human actor; services/job-approvals.ts#requestJobApproval only ever creates a PENDING
 * approval, never decides one), not from trusting this file to behave. A RED-tier agent job is
 * simply left QUEUED with no approval/authorization record - only a human, inside CT-OS itself,
 * can move it forward (services/job-approvals.ts#authorizeRedJob, APPROVER_ROLES only).
 */
import { z } from "zod";
import type { AuthUser } from "@/data/types";
import { createArtifact } from "@/services/artifacts";
import { createKnowledgeItem } from "@/services/knowledge";
import { createJob } from "@/services/agent-jobs";
import { requestJobApproval } from "@/services/job-approvals";
import { newId, nowIso } from "@/lib/core";
import { greenWrite, type McpToolDef } from "../types";

/** A requester identity for approval/job records raised via MCP - always labelled "(external)", never a real human's name (Part D). */
function externalRequester(clientName: string, clientId: string, onBehalfOfUserId?: string): AuthUser {
  return { id: onBehalfOfUserId ?? `ext_${clientId}`, email: null, displayName: `${clientName} (external)`, role: "TEAM_MEMBER" };
}

const ticketCreate = greenWrite({
  name: "ctos.ticket.create",
  title: "Create ticket",
  description: "Create a new ticket on a project (QUEUED, no approval implied). Does not start any job.",
  schema: z.object({
    projectId: z.string().min(1),
    title: z.string().min(1),
    agentId: z.string().min(1),
    phase: z.enum(["DISCOVERY", "UX", "CREATIVE", "CONTENT", "BUILD", "QA", "LAUNCH"]),
    priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
    objective: z.string().min(1),
    environment: z.string().optional(),
    scope: z.array(z.string()).optional(),
    doNotChange: z.array(z.string()).optional(),
  }),
  handler: (ctx, input) => {
    const d = ctx.store.data;
    const project = d.projects.find((p) => p.id === input.projectId);
    if (!project) throw new Error(`project ${input.projectId} not found`);
    const agent = d.agents.find((a) => a.id === input.agentId);
    if (!agent) throw new Error(`agent ${input.agentId} not found`);
    const at = nowIso();
    const extCount = d.tickets.filter((t) => t.projectId === input.projectId && t.code.startsWith("EXT-")).length;
    const code = `EXT-${String(extCount + 1).padStart(3, "0")}`;
    const maxOrder = d.tickets.filter((t) => t.projectId === input.projectId).reduce((m, t) => Math.max(m, t.order), 0);
    const ticket = {
      id: newId("t"),
      code,
      projectId: input.projectId,
      title: input.title,
      agentId: input.agentId,
      phase: input.phase,
      status: "QUEUED" as const,
      priority: input.priority ?? "P2",
      objective: input.objective,
      environment: input.environment ?? "",
      scope: input.scope ?? [],
      doNotChange: input.doNotChange ?? [],
      warnings: [] as string[],
      approvalState: "NOT_REQUIRED" as const,
      order: maxOrder + 1,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    };
    ctx.store.data = { ...d, tickets: [...d.tickets, ticket], activity: [...d.activity, { id: newId("act"), projectId: input.projectId, kind: "TICKET_CREATED" as const, ref: code, message: `${code} created via external assistant (${ctx.client.name}) — ${input.title}`, actor: ctx.client.name, actorId: null, at, order: d.activity.reduce((m, a) => Math.max(m, a.order), 0) + 1 }] };
    return { result: { ticketId: ticket.id, code }, requestedAction: `create ticket ${code} on project ${input.projectId}`, projectId: input.projectId, permissionTier: "READ" as const, createdIds: [ticket.id] };
  },
});

const ticketComment = greenWrite({
  name: "ctos.ticket.comment",
  title: "Comment on ticket",
  description: "Add a note to a ticket's activity history. Does not change ticket status.",
  schema: z.object({ ticketId: z.string().min(1), message: z.string().min(1) }),
  handler: (ctx, { ticketId, message }) => {
    const d = ctx.store.data;
    const ticket = d.tickets.find((t) => t.id === ticketId);
    if (!ticket) throw new Error(`ticket ${ticketId} not found`);
    const at = nowIso();
    const event = { id: newId("act"), projectId: ticket.projectId, kind: "NOTE" as const, ref: ticket.code, message: `${ctx.client.name}: ${message}`, actor: ctx.client.name, actorId: null, at, order: d.activity.reduce((m, a) => Math.max(m, a.order), 0) + 1 };
    ctx.store.data = { ...d, activity: [...d.activity, event] };
    return { result: { eventId: event.id }, requestedAction: `comment on ${ticket.code}`, projectId: ticket.projectId, createdIds: [event.id] };
  },
});

const clientFeedbackAdd = greenWrite({
  name: "ctos.client_feedback.add",
  title: "Add client feedback",
  description: "Record structured client feedback against a project as a DRAFT client_feedback artifact.",
  schema: z.object({ projectId: z.string().min(1), title: z.string().min(1), summary: z.string().optional(), content: z.unknown().optional() }),
  handler: (ctx, input) => {
    const d = ctx.store.data;
    const project = d.projects.find((p) => p.id === input.projectId);
    if (!project) throw new Error(`project ${input.projectId} not found`);
    const r = createArtifact(d, { projectId: input.projectId, type: "client_feedback", title: input.title, createdByAgentId: null, status: "DRAFT", summary: input.summary, content: input.content });
    const at = nowIso();
    ctx.store.data = { ...r.data, activity: [...r.data.activity, { id: newId("act"), projectId: input.projectId, kind: "ARTIFACT" as const, ref: undefined, message: `Client feedback recorded via external assistant (${ctx.client.name}) — ${input.title}`, actor: ctx.client.name, actorId: null, at, order: r.data.activity.reduce((m, a) => Math.max(m, a.order), 0) + 1 }] };
    return { result: { artifactId: r.artifact.id }, requestedAction: `add client feedback to project ${input.projectId}`, projectId: input.projectId, createdIds: [r.artifact.id] };
  },
});

const knowledgePropose = greenWrite({
  name: "ctos.knowledge.propose",
  title: "Propose knowledge",
  description: 'Propose a knowledge item (AGENCY or PROJECT scope only). Always lands as CANDIDATE — never auto-approved, regardless of who proposes it.',
  schema: z.object({
    title: z.string().min(1),
    content: z.string().min(1),
    category: z.enum(["safety", "qa", "build", "wordpress", "elementor", "design", "content", "conversion", "client", "process", "performance", "other"]),
    proposedScope: z.enum(["AGENCY", "PROJECT"]),
    projectId: z.string().optional(),
    evidence: z.array(z.string()).optional(),
  }),
  handler: (ctx, input) => {
    if (input.proposedScope === "PROJECT" && !input.projectId) throw new Error("PROJECT-scope proposals need a projectId");
    const r = createKnowledgeItem(ctx.store.data, { kind: "agent", agentId: `external:${ctx.client.id}` }, { scope: input.proposedScope, category: input.category, title: input.title, content: input.content, evidence: input.evidence ?? [], projectId: input.projectId ?? null });
    ctx.store.data = r.data;
    return { result: { knowledgeItemId: r.item.id, status: r.item.status }, requestedAction: `propose ${input.proposedScope} knowledge "${input.title}"`, projectId: input.projectId ?? null, createdIds: [r.item.id] };
  },
});

const agentJobRequest = greenWrite({
  name: "ctos.agent_job.request",
  title: "Request agent job",
  description: "Ask an agent to do one unit of work. GREEN jobs are simply queued (something inside CT-OS must still pick them up and run them — this tool never executes anything itself). AMBER jobs get a pending approval request a lead/admin must decide. RED jobs are left queued with the request logged; only a human, inside CT-OS, may authorize a RED action.",
  schema: z.object({
    projectId: z.string().min(1),
    agentId: z.string().min(1),
    instructions: z.string().min(1),
    taskType: z.enum(["research", "ux_architecture", "creative_direction", "seo_content", "build", "qa_audit", "deployment", "curate_lessons", "orchestrate"]).optional(),
    inputArtifactIds: z.array(z.string()).optional(),
    outputArtifactType: z.enum(["project_brief", "research_report", "site_blueprint", "design_system", "content_pack", "build_plan", "build_report", "qa_report", "client_feedback", "deployment_report", "lesson_candidate", "other"]).optional(),
    onBehalfOfUserId: z.string().optional(),
  }),
  handler: (ctx, input) => {
    const d = ctx.store.data;
    const agent = d.agents.find((a) => a.id === input.agentId);
    if (!agent) throw new Error(`agent ${input.agentId} not found`);
    const project = d.projects.find((p) => p.id === input.projectId);
    if (!project) throw new Error(`project ${input.projectId} not found`);
    const r = createJob(d, {
      projectId: input.projectId,
      agentId: input.agentId,
      instructions: input.instructions,
      taskType: input.taskType,
      inputArtifactIds: input.inputArtifactIds,
      outputArtifactType: input.outputArtifactType,
      requestedById: null,
    });
    let next = r.data;
    const job = r.job;
    const at = nowIso();
    let approvalId: string | null = null;
    let note: string;
    if (job.permissionLevel === "AMBER") {
      const requester = externalRequester(ctx.client.name, ctx.client.id, input.onBehalfOfUserId);
      const ar = requestJobApproval(next, job, requester, `${agent.shortCode} ${agent.name}`, { at });
      next = ar.data;
      approvalId = ar.approval.id;
      note = "AMBER — a pending approval request was created; a lead/admin must decide it in CT-OS before this job can run.";
    } else if (job.permissionLevel === "RED") {
      note = "RED — this request is logged only. No approval or authorization was created; a human must authorize this exact action directly inside CT-OS.";
    } else {
      note = "GREEN — queued. CT-OS (or an operator) still has to run it; this tool never executes a job itself.";
    }
    next = { ...next, activity: [...next.activity, { id: newId("act"), projectId: input.projectId, kind: "JOB" as const, ref: undefined, message: `Job requested via external assistant (${ctx.client.name}) for ${agent.shortCode} ${agent.name} — ${job.permissionLevel} — ${note}`, actor: ctx.client.name, actorId: null, at, order: next.activity.reduce((m, a) => Math.max(m, a.order), 0) + 1 }] };
    ctx.store.data = next;
    return { result: { jobId: job.id, status: job.status, permissionLevel: job.permissionLevel, approvalId, note }, requestedAction: `request ${job.permissionLevel} job for ${agent.shortCode} ${agent.name}`, projectId: input.projectId, permissionTier: job.permissionLevel, createdIds: approvalId ? [job.id, approvalId] : [job.id] };
  },
});

const approvalRequest = greenWrite({
  name: "ctos.approval.request",
  title: "Request approval",
  description: "Create (never decide) a pending approval: either an AMBER approval for an existing job, or a human decision gate on a project (STRATEGY/DESIGN/STAGING_BUILD/LAUNCH). A RED job cannot be approved this way — only logged; a human must authorize it directly in CT-OS.",
  schema: z.object({ jobId: z.string().optional(), projectId: z.string().optional(), gate: z.enum(["STRATEGY", "DESIGN", "STAGING_BUILD", "LAUNCH"]).optional(), onBehalfOfUserId: z.string().optional() }),
  handler: (ctx, input) => {
    if (!input.jobId && !(input.projectId && input.gate)) throw new Error("Provide either jobId, or both projectId and gate");
    const d = ctx.store.data;
    if (input.jobId) {
      const job = d.agentJobs.find((j) => j.id === input.jobId);
      if (!job) throw new Error(`job ${input.jobId} not found`);
      const agent = d.agents.find((a) => a.id === job.agentId);
      if (job.permissionLevel === "RED") {
        return { result: { ok: true, recorded: true, note: "RED actions require a human to authorize directly in CT-OS — no approval record was created; only this request is logged." }, requestedAction: `request approval for RED job ${job.id}`, projectId: job.projectId, permissionTier: "RED" as const };
      }
      if (job.permissionLevel === "GREEN") {
        return { result: { ok: true, note: "This job is GREEN — no approval is required." }, requestedAction: `request approval for GREEN job ${job.id}`, projectId: job.projectId, permissionTier: "GREEN" as const };
      }
      const requester = externalRequester(ctx.client.name, ctx.client.id, input.onBehalfOfUserId);
      const r = requestJobApproval(d, job, requester, agent ? `${agent.shortCode} ${agent.name}` : job.agentId);
      ctx.store.data = r.data;
      return { result: { approvalId: r.approval.id, created: r.created }, requestedAction: `request AMBER approval for job ${job.id}`, projectId: job.projectId, permissionTier: "AMBER" as const, createdIds: [r.approval.id] };
    }
    const project = d.projects.find((p) => p.id === input.projectId);
    if (!project) throw new Error(`project ${input.projectId} not found`);
    const at = nowIso();
    const gate = input.gate!;
    const approval = { id: newId("appr"), projectId: project.id, gate, requestedBy: `${ctx.client.name} (external)`, status: "PENDING" as const, decidedById: null, decidedAt: null, createdAt: at };
    ctx.store.data = { ...d, approvals: [...d.approvals, approval], activity: [...d.activity, { id: newId("act"), projectId: project.id, kind: "APPROVAL" as const, ref: undefined, message: `${gate} approval requested via external assistant (${ctx.client.name})`, actor: ctx.client.name, actorId: null, at, order: d.activity.reduce((m, a) => Math.max(m, a.order), 0) + 1 }] };
    return { result: { approvalId: approval.id }, requestedAction: `request ${gate} gate approval for project ${project.id}`, projectId: project.id, createdIds: [approval.id] };
  },
});

export const WRITE_TOOLS: McpToolDef<any>[] = [ticketCreate, ticketComment, clientFeedbackAdd, knowledgePropose, agentJobRequest, approvalRequest];

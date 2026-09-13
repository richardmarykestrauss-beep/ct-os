/**
 * OS store — the single in-memory state repository the whole UI consumes.
 *
 * Design: React context + reducer over an `OSData` snapshot loaded from an
 * OSRepository. Every mutation is an action so a Supabase-backed repository can
 * later replay the same actions as writes. Components never hold domain data.
 */
import * as React from "react";
import type {
  ActivityEvent,
  ActivityKind,
  Agent,
  Approval,
  ApprovalStatus,
  Client,
  LaunchHold,
  OSData,
  Platform,
  Project,
  ProjectPage,
  ProjectPhase,
  ProjectState,
  ProjectType,
  QAItem,
  Ticket,
  TicketApprovalState,
  TicketStatus,
} from "@/data/types";
import type { ActorRef, AgentProviderPolicy, ArtifactType, AuditFinding, AuditStatus, AuthUser, ExternalClientType, ExternalPermissionCeiling, KnowledgeScope, QARun, ServiceOpportunity, WebsiteAuditRequest } from "@/data/types";
import { PHASES, PROJECT_STATE_LABELS, STATE_PROGRESS, canTransition } from "@/data/state-machine";
import { AGENT_IDS } from "@/data/seed";
import { InMemoryRepository, type OSRepository, type RepositoryChoice } from "@/services/repository";
import { createArtifact } from "@/services/artifacts";
import { applyGatewayRecords, approveJobOutput, cancelJob, createJob, createJobForTicket, requestJobRevision, startJob } from "@/services/agent-jobs";
import { authorizeRedJob, checkPermission, decideJobApproval, effectiveLevel, requestJobApproval, type PermissionCheck } from "@/services/job-approvals";
import { proposeLesson, reviewKnowledgeItem, type ProposeLessonInput, type ReviewDecision } from "@/services/knowledge";
import { createExternalClient, generateExternalClientToken, revokeExternalClient, rotateExternalClientToken, setExternalClientStatus, type ExternalClientActor } from "@/services/external-clients";
import { PROVIDER_LABELS } from "@/ai/registry";
import type { GatewayClient } from "@/gateway/client";
import { EmbeddedGatewayClient, HttpGatewayClient } from "@/gateway/client";
import type { GatewayResponse } from "@/gateway/core";
import { newId, nowIso } from "@/lib/utils";
import { createAuditRequest as _createAuditRequest, updateAuditRequest as _updateAuditRequest, type AuditRequestPatch } from "@/services/website-audit";
import { runAuditPipeline, type CaptureResult } from "@/services/audit-orchestrator";
import type { SiteCapture } from "@/services/site-digest";

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface NewProjectInput {
  clientName: string;
  websiteUrl?: string;
  type: ProjectType;
  primaryGoal: string;
  platforms: Platform[];
  hasExistingWebsite: boolean;
  notes?: string;
}

/** Every human-initiated action carries the signed-in user. Agent/system actors are plain strings. */
type Action =
  | { type: "CREATE_PROJECT"; input: NewProjectInput; ids: { clientId: string; projectId: string; ticketId: string }; actor: AuthUser }
  | { type: "TRANSITION_PROJECT"; projectId: string; to: ProjectState; actor: AuthUser }
  | { type: "SET_TICKET_STATUS"; ticketId: string; status: TicketStatus; actor: AuthUser }
  | { type: "SET_TICKET_APPROVAL"; ticketId: string; approval: TicketApprovalState; actor: AuthUser }
  | { type: "RUN_TICKET_START"; ticketId: string; jobId: string; handoffId: string; actor: AuthUser }
  | { type: "APPLY_EXECUTION"; jobId: string; response: GatewayResponse; actor: AuthUser }
  | { type: "RUN_QA"; projectId: string; ticketId: string; qaRunId: string; actor: AuthUser }
  | { type: "CANCEL_JOB"; jobId: string; reason?: string; actor: AuthUser }
  | { type: "REVIEW_KNOWLEDGE"; itemId: string; decision: ReviewDecision; scope?: Exclude<KnowledgeScope, "TASK">; projectId?: string | null; actor: AuthUser }
  | { type: "PROPOSE_LESSON"; input: ProposeLessonInput; actor: AuthUser }
  | { type: "SET_AGENT_PROVIDER"; agentId: string; policy: Partial<AgentProviderPolicy>; actor: AuthUser }
  | { type: "DECIDE_APPROVAL"; approvalId: string; status: ApprovalStatus; notes?: string; actor: AuthUser }
  | { type: "DECIDE_JOB_APPROVAL"; approvalId: string; decision: "APPROVED" | "REJECTED"; note?: string; actor: AuthUser }
  | { type: "AUTHORIZE_JOB"; jobId: string; actor: AuthUser }
  | { type: "TOGGLE_HOLD"; holdId: string; actor: AuthUser }
  | { type: "SET_QA_ITEM_STATUS"; qaItemId: string; status: QAItem["status"]; actor: AuthUser }
  | { type: "NOTE"; projectId: string | null; message: string; actor: AuthUser }
  | { type: "CREATE_EXTERNAL_CLIENT"; id: string; rawToken: string; name: string; clientType: ExternalClientType; permissionCeiling: ExternalPermissionCeiling; actor: AuthUser }
  | { type: "SET_EXTERNAL_CLIENT_STATUS"; clientId: string; status: "ACTIVE" | "DISABLED"; actor: AuthUser }
  | { type: "ROTATE_EXTERNAL_CLIENT_TOKEN"; clientId: string; rawToken: string; actor: AuthUser }
  | { type: "REVOKE_EXTERNAL_CLIENT"; clientId: string; actor: AuthUser }
  // CTOS-007A: Website Audit Engine — the request is the run record; specialists are canonical AgentJobs
  | { type: "CREATE_AUDIT_REQUEST"; requestId: string; targetUrl: string; auditType: "PUBLIC_PROSPECT" | "CLIENT_DEEP_AUDIT"; projectId?: string | null; actor: AuthUser }
  | { type: "AUDIT_UPDATE"; requestId: string; patch: AuditRequestPatch; actor: AuthUser }
  | { type: "AUDIT_CAPTURED"; requestId: string; capture: SiteCapture; artifactId: string; actor: AuthUser }
  | { type: "AUDIT_JOBS_CREATED"; requestId: string; captureArtifactId: string; jobs: Array<{ id: string; agentId: string; outputType: ArtifactType; instructions: string; title: string }>; actor: AuthUser }
  | { type: "AUDIT_JOB_START"; jobId: string; inputArtifactIds: string[]; actor: AuthUser }
  | { type: "AUDIT_JOB_SETTLE"; jobId: string; requestId: string; actor: AuthUser }
  | { type: "AUDIT_COMPLETE"; requestId: string; status: Extract<AuditStatus, "COMPLETE" | "PARTIAL" | "NEEDS_A_HAND">; findings: AuditFinding[]; reportContent: Record<string, unknown>; summary: string; serviceOpportunities: ServiceOpportunity[]; actor: AuthUser }
  | { type: "AUDIT_FAILED"; requestId: string; reason: string; actor: AuthUser }
  | { type: "AUDIT_REVIEWED"; requestId: string; actor: AuthUser };

function ref(user: AuthUser): ActorRef {
  return { id: user.id, name: user.displayName };
}

function pushActivity(data: OSData, projectId: string | null, kind: ActivityKind, message: string, ref?: string, actor: ActorRef | string = "System"): ActivityEvent[] {
  const order = data.activity.reduce((m, a) => Math.max(m, a.order), 0) + 1;
  const name = typeof actor === "string" ? actor : actor.name;
  const actorId = typeof actor === "string" ? null : actor.id;
  return [...data.activity, { id: newId("act"), projectId, kind, ref, message, actor: name, actorId, at: nowIso(), order }];
}

/** Which job (if any) is the runnable one for a ticket, and whether the current user may run it now. */
export function ticketRunState(data: OSData, ticketId: string, user: AuthUser): { job: OSData["agentJobs"][number] | null; check: PermissionCheck | null; inFlight: boolean } {
  const ticket = data.tickets.find((t) => t.id === ticketId);
  if (!ticket) return { job: null, check: null, inFlight: false };
  const inFlight = data.agentJobs.some((j) => j.ticketId === ticket.id && (j.status === "RUNNING" || j.status === "WAITING_APPROVAL"));
  const job = data.agentJobs.find((j) => j.ticketId === ticket.id && j.status === "QUEUED") ?? null;
  const agent = data.agents.find((a) => a.id === ticket.agentId);
  if (!job || !agent) return { job, check: null, inFlight };
  const check = checkPermission({ level: effectiveLevel(job.permissionLevel, agent.permissionLevel), user, job, approvals: data.jobApprovals });
  return { job, check, inFlight };
}

function touchProject(projects: Project[], projectId: string, patch: Partial<Project> = {}): Project[] {
  return projects.map((p) => (p.id === projectId ? { ...p, ...patch, updatedAt: nowIso() } : p));
}

function reducer(data: OSData, action: Action): OSData {
  switch (action.type) {
    case "CREATE_PROJECT": {
      const { input, ids } = action;
      const now = nowIso();
      const client: Client = {
        id: ids.clientId,
        name: input.clientName,
        websiteUrl: input.websiteUrl || undefined,
        notes: input.notes,
        createdAt: now,
      };
      const platformSummary = input.platforms.length ? input.platforms.join(" + ") : "Platform TBC";
      const project: Project = {
        id: ids.projectId,
        clientId: ids.clientId,
        name: input.clientName,
        type: input.type,
        platforms: input.platforms,
        platformSummary,
        domain: input.websiteUrl || undefined,
        state: "DISCOVERY",
        statusLabel: "DISCOVERY IN PROGRESS",
        progress: STATE_PROGRESS.DISCOVERY,
        progressNote: "Approximate production progress.",
        currentPhase: "Research & Discovery",
        nextAction: "Run first discovery ticket",
        primaryGoal: input.primaryGoal,
        hasExistingWebsite: input.hasExistingWebsite,
        notes: input.notes,
        createdAt: now,
        updatedAt: now,
      };
      const phases: ProjectPhase[] = PHASES.map((p, i) => ({
        id: newId("ph"),
        projectId: project.id,
        key: p.key,
        label: p.label,
        status: i === 0 ? "IN_PROGRESS" : "NOT_STARTED",
        order: i + 1,
      }));
      const projectIndex = data.projects.length + 1;
      const code = `CT-P${projectIndex}-001`;
      const ticket: Ticket = {
        id: ids.ticketId,
        code,
        projectId: project.id,
        title: "Research & Discovery",
        agentId: AGENT_IDS.A01,
        phase: "DISCOVERY",
        status: "QUEUED",
        priority: "P2",
        objective: `Produce business, existing-site and competitor intelligence for ${input.clientName}. Primary goal: ${input.primaryGoal}`,
        environment: input.hasExistingWebsite && input.websiteUrl ? `Existing site — ${input.websiteUrl}` : "No existing website",
        scope: ["Business analysis", "Existing-site audit", "Competitor intelligence"],
        doNotChange: ["Any live site", "DNS / nameservers", "Payment credentials"],
        warnings: [],
        approvalState: "NOT_REQUIRED",
        order: 1,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      let next: OSData = {
        ...data,
        clients: [...data.clients, client],
        projects: [...data.projects, project],
        phases: [...data.phases, ...phases],
        tickets: [...data.tickets, ticket],
        approvals: [
          ...data.approvals,
          { id: newId("appr"), projectId: project.id, gate: "STRATEGY", requestedBy: "Orchestrator", status: "PENDING", decidedById: null, decidedAt: null, createdAt: now },
        ],
      };
      next = createArtifact(next, { projectId: project.id, type: "project_brief", title: "Project Brief", createdByAgentId: AGENT_IDS.ORCH, status: "FINAL", summary: input.primaryGoal, at: now }).data;
      next = { ...next, activity: pushActivity(next, project.id, "PROJECT_CREATED", `Project created — ${project.name} (${platformSummary})`, undefined, ref(action.actor)) };
      next = { ...next, activity: pushActivity(next, project.id, "TICKET_CREATED", `${code} created — Research & Discovery`, code, "Orchestrator") };
      return next;
    }

    case "TRANSITION_PROJECT": {
      const project = data.projects.find((p) => p.id === action.projectId);
      if (!project || !canTransition(project.state, action.to)) return data;
      const progress = action.to === "READY_TO_LAUNCH" || action.to === "QA" ? Math.max(project.progress, STATE_PROGRESS[action.to]) : STATE_PROGRESS[action.to];
      const projects = touchProject(data.projects, project.id, {
        state: action.to,
        statusLabel: PROJECT_STATE_LABELS[action.to].toUpperCase(),
        progress,
      });
      const next = { ...data, projects };
      return { ...next, activity: pushActivity(next, project.id, "STATE_CHANGED", `State changed ${PROJECT_STATE_LABELS[project.state]} → ${PROJECT_STATE_LABELS[action.to]}`, undefined, ref(action.actor)) };
    }

    case "SET_TICKET_STATUS": {
      const ticket = data.tickets.find((t) => t.id === action.ticketId);
      if (!ticket || ticket.status === action.status) return data;
      const now = nowIso();
      const tickets = data.tickets.map((t) =>
        t.id === ticket.id ? { ...t, status: action.status, updatedAt: now, completedAt: action.status === "COMPLETE" ? now : t.completedAt } : t,
      );
      let next: OSData = { ...data, tickets, projects: touchProject(data.projects, ticket.projectId) };
      // Keep agent status coherent with ticket status.
      next = { ...next, agents: syncAgent(next, ticket.agentId, ticket.id, action.status) };
      const kind: ActivityKind = action.status === "COMPLETE" ? "TICKET_COMPLETED" : "TICKET_STATUS";
      return { ...next, activity: pushActivity(next, ticket.projectId, kind, `${ticket.code} → ${action.status === "COMPLETE" ? "completed" : action.status.toLowerCase()} — ${ticket.title}`, ticket.code, ref(action.actor)) };
    }

    case "SET_TICKET_APPROVAL": {
      const ticket = data.tickets.find((t) => t.id === action.ticketId);
      if (!ticket) return data;
      const now = nowIso();
      const tickets = data.tickets.map((t) =>
        t.id === ticket.id
          ? {
              ...t,
              approvalState: action.approval,
              status: action.approval === "APPROVED" ? ("COMPLETE" as TicketStatus) : action.approval === "NEEDS_REVISION" ? ("READY" as TicketStatus) : t.status,
              updatedAt: now,
              completedAt: action.approval === "APPROVED" ? now : t.completedAt,
            }
          : t,
      );
      let next: OSData = { ...data, tickets, projects: touchProject(data.projects, ticket.projectId) };
      next = { ...next, agents: syncAgent(next, ticket.agentId, ticket.id, action.approval === "APPROVED" ? "COMPLETE" : action.approval === "NEEDS_REVISION" ? "READY" : ticket.status) };
      // Keep the ticket's job in step with the human decision.
      const job = [...next.agentJobs].reverse().find((j) => j.ticketId === ticket.id && j.status === "WAITING_APPROVAL");
      if (job && action.approval === "APPROVED") {
        next = approveJobOutput(next, job.id).data;
        next = { ...next, activity: pushActivity(next, ticket.projectId, "JOB", `Job output approved — artifact finalised`, ticket.code, ref(action.actor)) };
      } else if (job && action.approval === "NEEDS_REVISION") {
        next = requestJobRevision(next, job.id, "Needs revision (human review)").data;
        next = { ...next, activity: pushActivity(next, ticket.projectId, "JOB", `Job re-queued for revision`, ticket.code, ref(action.actor)) };
      }
      const msg = action.approval === "APPROVED" ? "approved" : action.approval === "NEEDS_REVISION" ? "sent back — needs revision" : "awaiting approval";
      return { ...next, activity: pushActivity(next, ticket.projectId, "APPROVAL", `${ticket.code} ${msg} — ${ticket.title}`, ticket.code, ref(action.actor)) };
    }

    case "RUN_TICKET_START": {
      // Creates (or re-uses) the ticket's job, then either starts it — if the permission tier allows —
      // or records the approval/authorization that is still needed. The gateway re-checks server-side.
      const ticket = data.tickets.find((t) => t.id === action.ticketId);
      if (!ticket) return data;
      if (data.agentJobs.some((j) => j.ticketId === ticket.id && (j.status === "RUNNING" || j.status === "WAITING_APPROVAL"))) return data;
      const now = nowIso();
      let next: OSData = data;
      const existing = next.agentJobs.find((j) => j.ticketId === ticket.id && j.status === "QUEUED");
      if (existing && existing.id !== action.jobId) return data;
      const jobId = action.jobId;
      if (!existing) next = createJobForTicket(next, ticket, { id: action.jobId, handoffId: action.handoffId, at: now, requestedById: action.actor.id }).data;
      const job = next.agentJobs.find((j) => j.id === jobId)!;
      const agent = next.agents.find((a) => a.id === job.agentId)!;
      const level = effectiveLevel(job.permissionLevel, agent.permissionLevel);
      const check = checkPermission({ level, user: action.actor, job, approvals: next.jobApprovals, now });
      if (check.outcome === "denied") {
        if (level === "AMBER" && action.actor.role !== "VIEWER") {
          const r = requestJobApproval(next, job, action.actor, `${agent.shortCode} ${agent.name}`, { at: now });
          next = r.data;
          if (r.created) next = { ...next, activity: pushActivity(next, ticket.projectId, "APPROVAL", `${ticket.code} needs AMBER approval before it can run — requested`, ticket.code, ref(action.actor)) };
        } else {
          next = { ...next, activity: pushActivity(next, ticket.projectId, "JOB", `${ticket.code} cannot run: ${check.reason}`, ticket.code, ref(action.actor)) };
        }
        return { ...next, projects: touchProject(next.projects, ticket.projectId, { nextAction: level === "RED" ? `Authorize ${ticket.code} (RED) in Approvals` : level === "AMBER" ? `Approve ${ticket.code} (AMBER) in Approvals` : ticket.title }) };
      }
      next = startJob(next, jobId).data;
      next = { ...next, tickets: next.tickets.map((t) => (t.id === ticket.id ? { ...t, status: "BUILDING" as TicketStatus, updatedAt: now } : t)), projects: touchProject(next.projects, ticket.projectId, { nextAction: `Wait for ${ticket.code} to finish` }) };
      next = { ...next, agents: syncAgent(next, ticket.agentId, ticket.id, "BUILDING") };
      next = { ...next, activity: pushActivity(next, ticket.projectId, "JOB", `${ticket.code} job started (${level}) — preferred provider ${PROVIDER_LABELS[job.preferredProvider]}${job.inputArtifactIds.length ? ` · ${job.inputArtifactIds.length} input artifact(s)` : ""}`, ticket.code, ref(action.actor)) };
      return next;
    }

    case "APPLY_EXECUTION": {
      // Mirror what the gateway produced (it already persisted server-side in Supabase mode).
      const job = data.agentJobs.find((j) => j.id === action.jobId);
      if (!job) return data;
      const ticket = job.ticketId ? data.tickets.find((t) => t.id === job.ticketId) : null;
      const now = nowIso();
      const res = action.response;
      if (!res.ok) {
        // Transport failure or 5xx: the server may still have completed. Leave the job as it is and say so.
        if (res.code === "internal" && (res.status === 0 || res.status >= 500)) {
          return { ...data, activity: pushActivity(data, job.projectId, "JOB", `Gateway unreachable for ${ticket?.code ?? "job"} (${res.message}). The job may still complete server-side — reload to see its state.`, ticket?.code, "Execution gateway") };
        }
        // Gateway refused (auth / permission / state). Job goes back to QUEUED so it can be retried once fixed.
        let next: OSData = job.status === "RUNNING" ? { ...data, agentJobs: data.agentJobs.map((j) => (j.id === job.id ? { ...j, status: "QUEUED" as const, error: res.message, updatedAt: now } : j)) } : data;
        if (ticket && ticket.status === "BUILDING") {
          next = { ...next, tickets: next.tickets.map((t) => (t.id === ticket.id ? { ...t, status: "READY" as TicketStatus, updatedAt: now } : t)) };
          next = { ...next, agents: syncAgent(next, ticket.agentId, ticket.id, "READY") };
        }
        return { ...next, activity: pushActivity(next, job.projectId, "JOB", `Gateway refused ${ticket?.code ?? "job"}: ${res.message}`, ticket?.code, "Execution gateway") };
      }
      if (job.status !== "RUNNING") {
        // Cancelled (or otherwise moved on) while the gateway was executing: keep the evidence, not the state change.
        const evidenceOnly = { ...res.records, job, handoff: null };
        const next = applyGatewayRecords(data, evidenceOnly);
        return { ...next, activity: pushActivity(next, job.projectId, "JOB", `Execution result for ${ticket?.code ?? "job"} arrived after it was ${job.status.toLowerCase()} — runs and logs kept, state unchanged`, ticket?.code, "Execution gateway") };
      }
      let next = applyGatewayRecords(data, res.records);
      const result = res.result;
      if (result.status === "COMPLETED") {
        const artifact = res.records.artifact;
        if (ticket) {
          next = {
            ...next,
            tickets: next.tickets.map((t) =>
              t.id === ticket.id
                ? {
                    ...t,
                    status: "REVIEW" as TicketStatus,
                    approvalState: "PENDING" as TicketApprovalState,
                    executionOutput: `${res.records.runs.find((r) => r.status === "SUCCEEDED")?.outputSummary ?? "Output produced."}\n\nOutput artifact: ${artifact?.title ?? "—"} (v${artifact?.version ?? 1}) · validated against ${result.outputSchema}.`,
                    safetyCheck: result.finishReason === "stub" ? "Stub provider — no external systems touched." : "Provider call only — no client systems touched.",
                    updatedAt: now,
                  }
                : t,
            ),
            projects: touchProject(next.projects, ticket.projectId, { nextAction: `Review ${ticket.code} output` }),
          };
          next = { ...next, agents: syncAgent(next, ticket.agentId, ticket.id, "REVIEW") };
        }
        const fellBack = result.provider && result.provider !== job.preferredProvider;
        const trail = result.attempts.filter((a) => a.outcome !== "succeeded").map((a) => `${PROVIDER_LABELS[a.providerId]} — ${a.outcome.replace("_", " ")}`);
        return { ...next, activity: pushActivity(next, job.projectId, "ARTIFACT", `${artifact?.title ?? "Artifact"} v${artifact?.version ?? 1} produced by ${result.provider ? PROVIDER_LABELS[result.provider] : "provider"}${result.model ? ` (${result.model})` : ""}${fellBack ? ` after fallback: ${trail.join(" · ")}` : ""} — waiting for review`, ticket?.code, "Execution gateway") };
      }
      // FAILED / FAILED_VALIDATION
      if (ticket) {
        next = {
          ...next,
          tickets: next.tickets.map((t) => (t.id === ticket.id ? { ...t, status: "BLOCKED" as TicketStatus, warnings: [...t.warnings, `Job ${result.status.toLowerCase().replace("_", " ")}: ${result.error?.message ?? "unknown error"}`], updatedAt: now } : t)),
          projects: touchProject(next.projects, ticket.projectId, { nextAction: `Resolve failed job on ${ticket.code}` }),
        };
        next = { ...next, agents: syncAgent(next, ticket.agentId, ticket.id, "BLOCKED") };
      }
      const trail = result.attempts.map((a) => `${PROVIDER_LABELS[a.providerId]} — ${a.outcome.replace("_", " ")}`).join(" · ");
      return { ...next, activity: pushActivity(next, job.projectId, "JOB", `Job ${result.status === "FAILED_VALIDATION" ? "failed validation" : "failed"}${trail ? `: ${trail}` : ""}`, ticket?.code, "Execution gateway") };
    }

    case "RUN_QA": {
      const project = data.projects.find((p) => p.id === action.projectId);
      if (!project) return data;
      const now = nowIso();
      const open = data.qaItems.filter((q) => q.projectId === project.id && (q.status === "OPEN" || q.status === "IN_PROGRESS")).length;
      const projectTickets = data.tickets.filter((t) => t.projectId === project.id);
      const prefix = project.id === "proj_uproof" ? "CT-UP" : `CT-P${data.projects.findIndex((p) => p.id === project.id) + 1}`;
      // Next code = highest existing numeric code + 1 (a plain count would re-issue CT-UP-020 on U-Proof).
      const highest = projectTickets.reduce((m, t) => Math.max(m, Number(t.code.replace(`${prefix}-`, "").match(/^\d+/)?.[0] ?? 0)), 0);
      const seq = Math.max(highest, projectTickets.length) + 1;
      const code = `${prefix}-${String(seq).padStart(3, "0")}`;
      const ticket: Ticket = {
        id: action.ticketId,
        code,
        projectId: project.id,
        title: "QA Run (local)",
        agentId: AGENT_IDS.A06,
        phase: "QA",
        status: "COMPLETE",
        priority: "P2",
        objective: "Re-run QA across the current build state.",
        environment: "Staging",
        scope: ["All tracked pages"],
        doNotChange: ["Live production site"],
        executionOutput: `[Local mock run] QA re-run recorded. Open defects in store: ${open}. No real audit was executed — the QA & Launch Auditor execution plane is not connected.`,
        safetyCheck: "Mock run — read-only.",
        warnings: [],
        approvalState: "NOT_REQUIRED",
        order: seq,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      };
      const qaRun: QARun = {
        id: action.qaRunId,
        projectId: project.id,
        ticketId: ticket.id,
        runByAgentId: AGENT_IDS.A06,
        scope: ticket.scope,
        result: "INCOMPLETE",
        counts: qaSeverityCounts(data.qaItems.filter((q) => q.projectId === project.id)),
        summary: "Local run — no audit executed. Counts reflect open items already in the store.",
        startedAt: now,
        finishedAt: now,
      };
      let next: OSData = { ...data, tickets: [...data.tickets, ticket], qaRuns: [...data.qaRuns, qaRun], projects: touchProject(data.projects, project.id) };
      next = { ...next, agents: next.agents.map((a) => (a.id === AGENT_IDS.A06 ? { ...a, lastRunAt: now, outputsProduced: a.outputsProduced + 1, currentProjectId: project.id, currentTicketId: null, status: "IDLE" } : a)) };
      next = { ...next, activity: pushActivity(next, project.id, "QA_RUN", `${code} QA run (mock) — ${open} open defect${open === 1 ? "" : "s"}`, code, ref(action.actor)) };
      return next;
    }

    case "DECIDE_APPROVAL": {
      const approval = data.approvals.find((a) => a.id === action.approvalId);
      if (!approval) return data;
      const now = nowIso();
      const approvals = data.approvals.map((a) =>
        a.id === approval.id ? { ...a, status: action.status, notes: action.notes ?? a.notes, decidedBy: action.status === "PENDING" ? undefined : action.actor.displayName, decidedById: action.status === "PENDING" ? null : action.actor.id, decidedAt: action.status === "PENDING" ? null : now } : a,
      );
      let next: OSData = { ...data, approvals, projects: touchProject(data.projects, approval.projectId) };
      if (approval.gate === "LAUNCH") {
        const orchStatus: Agent["status"] = action.status === "APPROVED" ? "IDLE" : action.status === "CHANGES_REQUESTED" ? "BLOCKED" : "WAITING_APPROVAL";
        next = { ...next, agents: next.agents.map((a) => (a.id === AGENT_IDS.ORCH ? { ...a, status: orchStatus, statusDetail: action.status === "APPROVED" ? "Launch approved" : action.status === "CHANGES_REQUESTED" ? "Launch changes requested" : "Human Review" } : a)) };
      }
      const label = action.status === "APPROVED" ? "approved" : action.status === "CHANGES_REQUESTED" ? "changes requested" : "reset to pending";
      return { ...next, activity: pushActivity(next, approval.projectId, "APPROVAL", `${approval.gate.replace("_", " ")} gate ${label}`, approval.gate, ref(action.actor)) };
    }

    case "TOGGLE_HOLD": {
      const hold = data.launchHolds.find((h) => h.id === action.holdId);
      if (!hold) return data;
      const resolved = !hold.resolved;
      const now = nowIso();
      const launchHolds: LaunchHold[] = data.launchHolds.map((h) => (h.id === hold.id ? { ...h, resolved, resolvedAt: resolved ? now : null } : h));
      // Keep page hold notes coherent.
      const pages: ProjectPage[] = data.pages.map((p) => {
        if (!hold.pageId || p.id !== hold.pageId) return p;
        const stillHeld = launchHolds.some((h) => h.pageId === p.id && !h.resolved);
        // Reopening restores a note; the original short label is gone once cleared, so fall back to the hold title.
        return { ...p, holdNote: stillHeld ? (p.holdNote ?? hold.title) : undefined, updatedAt: now };
      });
      const next: OSData = { ...data, launchHolds, pages, projects: touchProject(data.projects, hold.projectId) };
      return { ...next, activity: pushActivity(next, hold.projectId, "HOLD", `Launch hold ${resolved ? "resolved" : "reopened"} — ${hold.title}`, undefined, ref(action.actor)) };
    }

    case "SET_QA_ITEM_STATUS": {
      const item = data.qaItems.find((q) => q.id === action.qaItemId);
      if (!item) return data;
      const now = nowIso();
      const qaItems = data.qaItems.map((q) => (q.id === item.id ? { ...q, status: action.status, resolvedAt: action.status === "FIXED" || action.status === "VERIFIED" ? now : null } : q));
      const next: OSData = { ...data, qaItems, projects: touchProject(data.projects, item.projectId) };
      return { ...next, activity: pushActivity(next, item.projectId, "QA_FIX", `QA item ${action.status.toLowerCase()} — ${item.title}`, undefined, ref(action.actor)) };
    }

    case "CANCEL_JOB": {
      const job = data.agentJobs.find((j) => j.id === action.jobId);
      if (!job || job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED") return data;
      let next = cancelJob(data, job.id, action.reason).data;
      const ticket = job.ticketId ? next.tickets.find((t) => t.id === job.ticketId) : null;
      if (ticket && (ticket.status === "BUILDING" || ticket.status === "REVIEW")) {
        next = { ...next, tickets: next.tickets.map((t) => (t.id === ticket.id ? { ...t, status: "QUEUED" as TicketStatus, approvalState: "NOT_REQUIRED" as TicketApprovalState, updatedAt: nowIso() } : t)) };
        next = { ...next, agents: syncAgent(next, ticket.agentId, ticket.id, "QUEUED") };
      }
      return { ...next, activity: pushActivity(next, job.projectId, "JOB", `Job cancelled${action.reason ? ` — ${action.reason}` : ""}`, ticket?.code, ref(action.actor)) };
    }

    case "REVIEW_KNOWLEDGE": {
      try {
        if (action.actor.role === "VIEWER") return data;
        const r = reviewKnowledgeItem(data, { kind: "human", name: action.actor.displayName, id: action.actor.id }, action.itemId, action.decision, { scope: action.scope, projectId: action.projectId });
        const label = action.decision === "APPROVED" ? "approved" : action.decision === "REJECTED" ? "rejected" : "deprecated";
        return { ...r.data, activity: pushActivity(r.data, r.item.projectId, "KNOWLEDGE", `Knowledge ${label} — ${r.item.title} [${r.item.scope}]`, undefined, ref(action.actor)) };
      } catch {
        return data;
      }
    }

    case "CREATE_EXTERNAL_CLIENT": {
      try {
        const toExternalActor = (u: AuthUser): ExternalClientActor => ({ kind: "human", id: u.id, name: u.displayName, role: u.role });
        const r = createExternalClient(data, toExternalActor(action.actor), { id: action.id, rawToken: action.rawToken, name: action.name, type: action.clientType, permissionCeiling: action.permissionCeiling });
        return { ...r.data, activity: pushActivity(r.data, null, "NOTE", `External assistant registered - ${r.client.name} [${r.client.permissionCeiling}]`, undefined, ref(action.actor)) };
      } catch {
        return data;
      }
    }

    case "SET_EXTERNAL_CLIENT_STATUS": {
      try {
        const toExternalActor = (u: AuthUser): ExternalClientActor => ({ kind: "human", id: u.id, name: u.displayName, role: u.role });
        const r = setExternalClientStatus(data, toExternalActor(action.actor), action.clientId, action.status);
        return { ...r.data, activity: pushActivity(r.data, null, "NOTE", `External assistant ${action.status === "ACTIVE" ? "enabled" : "disabled"} - ${r.client.name}`, undefined, ref(action.actor)) };
      } catch {
        return data;
      }
    }

    case "ROTATE_EXTERNAL_CLIENT_TOKEN": {
      try {
        const toExternalActor = (u: AuthUser): ExternalClientActor => ({ kind: "human", id: u.id, name: u.displayName, role: u.role });
        const r = rotateExternalClientToken(data, toExternalActor(action.actor), action.clientId, action.rawToken);
        return { ...r.data, activity: pushActivity(r.data, null, "NOTE", `External assistant credential rotated - ${r.client.name}`, undefined, ref(action.actor)) };
      } catch {
        return data;
      }
    }

    case "REVOKE_EXTERNAL_CLIENT": {
      try {
        const toExternalActor = (u: AuthUser): ExternalClientActor => ({ kind: "human", id: u.id, name: u.displayName, role: u.role });
        const r = revokeExternalClient(data, toExternalActor(action.actor), action.clientId);
        return { ...r.data, activity: pushActivity(r.data, null, "NOTE", `External assistant revoked - ${r.client.name}`, undefined, ref(action.actor)) };
      } catch {
        return data;
      }
    }

    case "PROPOSE_LESSON": {
      try {
        const r = proposeLesson(data, action.input);
        const agent = data.agents.find((a) => a.id === action.input.agentId);
        return { ...r.data, activity: pushActivity(r.data, action.input.projectId, "KNOWLEDGE", `Lesson candidate proposed — ${r.item.title}`, undefined, agent ? `${agent.shortCode} ${agent.name}` : ref(action.actor)) };
      } catch {
        return data;
      }
    }

    case "SET_AGENT_PROVIDER": {
      const agent = data.agents.find((a) => a.id === action.agentId);
      if (!agent) return data;
      const policy: AgentProviderPolicy = { ...agent.providerPolicy, ...action.policy };
      policy.fallbacks = policy.fallbacks.filter((p) => p !== policy.preferred);
      const agents = data.agents.map((a) => (a.id === agent.id ? { ...a, providerPolicy: policy, updatedAt: nowIso() } : a));
      const next = { ...data, agents };
      return { ...next, activity: pushActivity(next, null, "AGENT", `${agent.shortCode} ${agent.name} — provider policy: ${PROVIDER_LABELS[policy.preferred]}${policy.fallbacks.length ? ` → ${policy.fallbacks.map((p) => PROVIDER_LABELS[p]).join(" → ")}` : ""}`, undefined, ref(action.actor)) };
    }

    case "DECIDE_JOB_APPROVAL": {
      try {
        const r = decideJobApproval(data, action.approvalId, action.decision, action.actor, action.note);
        const job = data.agentJobs.find((j) => j.id === r.approval.jobId);
        const ticket = job?.ticketId ? data.tickets.find((t) => t.id === job.ticketId) : null;
        let next = r.data;
        if (ticket) next = { ...next, projects: touchProject(next.projects, ticket.projectId, { nextAction: action.decision === "APPROVED" ? `Run ${ticket.code} (approved)` : `Revise ${ticket.code} — approval rejected` }) };
        return { ...next, activity: pushActivity(next, r.approval.projectId, "APPROVAL", `AMBER ${action.decision === "APPROVED" ? "approved" : "rejected"} — ${r.approval.requestedAction}`, ticket?.code, ref(action.actor)) };
      } catch {
        return data;
      }
    }

    case "AUTHORIZE_JOB": {
      const job = data.agentJobs.find((j) => j.id === action.jobId);
      if (!job) return data;
      const agent = data.agents.find((a) => a.id === job.agentId);
      try {
        const r = authorizeRedJob(data, job, action.actor, agent ? `${agent.shortCode} ${agent.name}` : job.agentId);
        const ticket = job.ticketId ? data.tickets.find((t) => t.id === job.ticketId) : null;
        return { ...r.data, activity: pushActivity(r.data, job.projectId, "APPROVAL", `RED action explicitly authorized — ${r.approval.requestedAction}`, ticket?.code, ref(action.actor)) };
      } catch {
        return data;
      }
    }

    case "NOTE": {
      return { ...data, activity: pushActivity(data, action.projectId, "NOTE", action.message, undefined, ref(action.actor)) };
    }

    // CTOS-007A: Website Audit Engine
    case "CREATE_AUDIT_REQUEST": {
      const result = _createAuditRequest(data, {
        id: action.requestId,
        targetUrl: action.targetUrl,
        auditType: action.auditType,
        projectId: action.projectId,
        requestedById: action.actor.id,
        requestedByName: action.actor.displayName,
      });
      if (!result.ok) return data;
      return { ...result.data, activity: pushActivity(result.data, action.projectId ?? null, "NOTE", `Audit requested: ${result.request.targetUrl}`, undefined, ref(action.actor)) };
    }

    case "AUDIT_UPDATE":
      return _updateAuditRequest(data, action.requestId, action.patch);

    case "AUDIT_CAPTURED": {
      const request = data.websiteAuditRequests.find((r) => r.id === action.requestId);
      if (!request) return data;
      const created = createArtifact(data, {
        id: action.artifactId,
        projectId: auditProjectId(request),
        type: "audit_capture",
        title: `Capture — ${hostOf(request.targetUrl)}`,
        createdByAgentId: null,
        status: "FINAL",
        summary: `${action.capture.pages.length} page(s) captured, ${action.capture.skippedUrls.length} skipped, ${action.capture.screenshots.length} screenshot(s).`,
        content: action.capture,
      });
      return _updateAuditRequest(created.data, action.requestId, { progressMessage: `Capture evidence stored (${action.capture.pages.length} page digest(s)).` });
    }

    case "AUDIT_JOBS_CREATED": {
      const request = data.websiteAuditRequests.find((r) => r.id === action.requestId);
      if (!request) return data;
      const projectId = auditProjectId(request);
      let next = data;
      const created: string[] = [];
      for (const j of action.jobs) {
        try {
          next = createJob(next, { id: j.id, projectId, agentId: j.agentId, instructions: j.instructions, inputArtifactIds: [action.captureArtifactId], outputArtifactType: j.outputType, requestedById: action.actor.id }).data;
          created.push(j.id);
        } catch (err) {
          next = _updateAuditRequest(next, action.requestId, { progressMessage: `Could not queue ${j.agentId}: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
      next = _updateAuditRequest(next, action.requestId, { auditJobIds: created });
      return { ...next, activity: pushActivity(next, request.projectId, "JOB", `Audit queued ${created.length} specialist job(s) for ${request.targetUrl}`, undefined, ref(action.actor)) };
    }

    case "AUDIT_JOB_START": {
      const existing = data.agentJobs.find((j) => j.id === action.jobId);
      if (!existing || existing.status !== "QUEUED") return data;
      try {
        const withInputs: OSData = { ...data, agentJobs: data.agentJobs.map((j) => (j.id === action.jobId ? { ...j, inputArtifactIds: action.inputArtifactIds } : j)) };
        const r = startJob(withInputs, action.jobId);
        const request = data.websiteAuditRequests.find((x) => x.auditJobIds.includes(action.jobId));
        const agents = r.data.agents.map((a) => (a.id !== r.job.agentId ? a : { ...a, status: "WORKING" as Agent["status"], statusDetail: request ? `Audit ${hostOf(request.targetUrl)}` : "Audit", currentProjectId: request?.projectId ?? a.currentProjectId, currentTicketId: null, lastRunAt: nowIso() }));
        return { ...r.data, agents };
      } catch {
        return data;
      }
    }

    case "AUDIT_JOB_SETTLE": {
      // Audit passes are analysis, not site changes: a validated artifact completes the job (A06 reviews
      // independently and the final report still goes to a human). Failures stay as the gateway left them.
      const job = data.agentJobs.find((j) => j.id === action.jobId);
      if (!job) return data;
      let next = data;
      if (job.status === "WAITING_APPROVAL") {
        try {
          next = approveJobOutput(next, job.id).data;
        } catch {
          return data;
        }
      }
      const settled = next.agentJobs.find((j) => j.id === action.jobId)!;
      const winner = next.agentRuns.find((r) => r.jobId === job.id && r.status === "SUCCEEDED");
      const label = settled.status === "COMPLETED" ? `completed on ${winner ? PROVIDER_LABELS[winner.providerId] : "provider"}${winner?.model ? ` (${winner.model})` : ""}` : `${settled.status.toLowerCase().replace(/_/g, " ")}${settled.error ? ` — ${settled.error}` : ""}`;
      next = _updateAuditRequest(next, action.requestId, { progressMessage: `${agentShortCode(next, job.agentId)} ${label}` });
      const agents = next.agents.map((a) => (a.id !== job.agentId ? a : { ...a, status: "IDLE" as Agent["status"], statusDetail: undefined, currentTicketId: null, outputsProduced: settled.status === "COMPLETED" ? a.outputsProduced + 1 : a.outputsProduced }));
      return { ...next, agents };
    }

    case "AUDIT_COMPLETE": {
      const request = data.websiteAuditRequests.find((r) => r.id === action.requestId);
      if (!request) return data;
      const now = nowIso();
      const findings = action.findings.map((f) => ({ ...f, createdAt: f.createdAt ?? now }));
      let next: OSData = { ...data, auditFindings: [...data.auditFindings, ...findings] };
      const created = createArtifact(next, {
        projectId: auditProjectId(request),
        type: "website_audit_report",
        title: `Audit report — ${hostOf(request.targetUrl)}`,
        createdByAgentId: null,
        status: "FINAL",
        summary: action.summary,
        content: action.reportContent,
      });
      next = _updateAuditRequest(created.data, action.requestId, { status: action.status, resultArtifactId: created.artifact.id, failureReason: action.status === "NEEDS_A_HAND" ? "No specialist agent completed — report is heuristic-only. Check provider availability and re-run." : null, progressMessage: `Synthesis complete (${action.status}) — ${action.summary}` });
      const clientFacing = findings.filter((f) => f.kind !== "RAW").length;
      return { ...next, activity: pushActivity(next, request.projectId, "ARTIFACT", `Audit ${action.status.toLowerCase().replace(/_/g, " ")}: ${request.targetUrl} — ${clientFacing} finding(s)`, undefined, ref(action.actor)) };
    }

    case "AUDIT_FAILED": {
      const request = data.websiteAuditRequests.find((r) => r.id === action.requestId);
      if (!request) return data;
      let next = data;
      for (const jobId of request.auditJobIds) {
        const job = next.agentJobs.find((j) => j.id === jobId);
        if (job && (job.status === "QUEUED" || job.status === "RUNNING")) next = cancelJob(next, jobId, action.reason).data;
      }
      next = _updateAuditRequest(next, action.requestId, { status: "FAILED", failureReason: action.reason, progressMessage: `Failed: ${action.reason}` });
      return { ...next, activity: pushActivity(next, request.projectId, "NOTE", `Audit failed: ${request.targetUrl} — ${action.reason}`, undefined, ref(action.actor)) };
    }

    case "AUDIT_REVIEWED":
      return _updateAuditRequest(data, action.requestId, { reviewedAt: nowIso(), progressMessage: `Reviewed by ${action.actor.displayName}` });
  }
}

/** Audit artifacts/jobs are scoped to the project when run from one; otherwise to the request itself. */
function auditProjectId(request: WebsiteAuditRequest): string {
  return request.projectId ?? request.id;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function agentShortCode(data: OSData, agentId: string): string {
  const a = data.agents.find((x) => x.id === agentId);
  return a ? `A${a.shortCode}` : agentId;
}

/** Public-site capture runs server-side (SSRF-checked, bounded) and returns page digests, never raw HTML. */
async function captureViaServer(targetUrl: string): Promise<CaptureResult> {
  try {
    const res = await fetch("/site-capture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: targetUrl }) });
    const body = (await res.json().catch(() => null)) as { ok: boolean; capture?: SiteCapture; error?: string; reason?: string } | null;
    if (!body) return { ok: false, error: `Capture endpoint returned HTTP ${res.status}` };
    if (!body.ok || !body.capture || !body.capture.pages.length) return { ok: false, error: body.error ?? body.reason ?? "No pages captured" };
    return { ok: true, capture: body.capture };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Reflect a ticket status change onto its agent so the Agents screen stays truthful. */
function syncAgent(data: OSData, agentId: string, ticketId: string, ticketStatus: TicketStatus): Agent[] {
  const ticket = data.tickets.find((t) => t.id === ticketId);
  return data.agents.map((a) => {
    if (a.id !== agentId) return a;
    const now = nowIso();
    switch (ticketStatus) {
      case "BUILDING":
        return { ...a, status: "WORKING", statusDetail: undefined, currentProjectId: ticket?.projectId ?? a.currentProjectId, currentTicketId: ticketId, lastRunAt: now };
      case "REVIEW":
        return { ...a, status: "WAITING_APPROVAL", statusDetail: "Output review", currentProjectId: ticket?.projectId ?? a.currentProjectId, currentTicketId: ticketId, lastRunAt: now, outputsProduced: a.outputsProduced + 1 };
      case "BLOCKED":
        return { ...a, status: "BLOCKED", statusDetail: "Ticket blocked", currentProjectId: ticket?.projectId ?? a.currentProjectId, currentTicketId: ticketId };
      case "COMPLETE":
      case "QUEUED":
      case "READY":
        return a.currentTicketId === ticketId ? { ...a, status: "IDLE", statusDetail: undefined, currentTicketId: null } : a;
    }
  });
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface StoreStatus {
  repositoryKind: OSRepository["kind"];
  description: string;
  reason: string | null;
  persistError: string | null;
  /** "http" when executions go to the server-side gateway, "embedded" in local mode. */
  gatewayKind: GatewayClient["kind"];
}

export type RunOutcome = { kind: "executed"; response: GatewayResponse } | { kind: "needs_approval"; level: "AMBER" | "RED"; reason: string } | { kind: "skipped"; reason: string };

interface OSStoreValue {
  data: OSData;
  user: AuthUser;
  repositoryKind: OSRepository["kind"];
  status: StoreStatus;
  gateway: GatewayClient;
  actions: {
    createProject: (input: NewProjectInput) => { projectId: string; clientId: string };
    transitionProject: (projectId: string, to: ProjectState) => void;
    setTicketStatus: (ticketId: string, status: TicketStatus) => void;
    setTicketApproval: (ticketId: string, approval: TicketApprovalState) => void;
    /** Creates/starts the ticket's job and executes it through the gateway (permission enforced there). */
    runTicket: (ticketId: string) => Promise<RunOutcome>;
    runQA: (projectId: string) => void;
    decideApproval: (approvalId: string, status: ApprovalStatus, notes?: string) => void;
    decideJobApproval: (approvalId: string, decision: "APPROVED" | "REJECTED", note?: string) => void;
    authorizeJob: (jobId: string) => void;
    toggleHold: (holdId: string) => void;
    setQAItemStatus: (qaItemId: string, status: QAItem["status"]) => void;
    cancelJob: (jobId: string, reason?: string) => void;
    reviewKnowledge: (itemId: string, decision: ReviewDecision, opts?: { scope?: Exclude<KnowledgeScope, "TASK">; projectId?: string | null }) => void;
    proposeLesson: (input: ProposeLessonInput) => void;
    setAgentProvider: (agentId: string, policy: Partial<AgentProviderPolicy>) => void;
    note: (projectId: string | null, message: string) => void;
    createExternalClient: (input: { name: string; type: ExternalClientType; permissionCeiling: ExternalPermissionCeiling }) => { id: string; rawToken: string };
    setExternalClientStatus: (clientId: string, status: "ACTIVE" | "DISABLED") => void;
    rotateExternalClientToken: (clientId: string) => { rawToken: string };
    revokeExternalClient: (clientId: string) => void;
    // CTOS-007A: Website Audit Engine
    /** Creates the request and runs capture → A01 → A02 → A03‖A04 → A06 → synthesis as canonical AgentJobs. Resolves when the audit is settled. */
    startAudit: (targetUrl: string, auditType: "PUBLIC_PROSPECT" | "CLIENT_DEEP_AUDIT", projectId?: string | null) => Promise<{ ok: true; requestId: string } | { ok: false; reason: string }>;
    markAuditReviewed: (requestId: string) => void;
  };
}

const OSStoreContext = React.createContext<OSStoreValue | null>(null);

interface Boot {
  repository: OSRepository;
  data: OSData;
  reason: string | null;
}

function bootSync(repository: OSRepository | Promise<RepositoryChoice> | undefined): Boot | null {
  if (!repository || repository instanceof Promise || repository.kind !== "memory") return null;
  const loaded = repository.load();
  if (loaded instanceof Promise) return null;
  return { repository, data: loaded, reason: null };
}

/**
 * Boots the repository (sync for in-memory, async for Supabase), then mounts the store for the
 * signed-in user. If a persistent repository fails to load, CT-OS falls back to the in-memory seed and says so.
 */
export function OSStoreProvider({
  children,
  repository,
  user,
  gateway,
}: {
  children: React.ReactNode;
  repository?: OSRepository | Promise<RepositoryChoice>;
  user: AuthUser;
  /** Omit to use the embedded (local, stub-only) gateway. */
  gateway?: GatewayClient;
}) {
  const [boot, setBoot] = React.useState<Boot | null>(() => {
    if (repository) return bootSync(repository);
    const fallback = new InMemoryRepository();
    return { repository: fallback, data: fallback.load(), reason: "default in-memory repository" };
  });

  React.useEffect(() => {
    if (boot) return;
    let cancelled = false;
    (async () => {
      let repo: OSRepository = new InMemoryRepository();
      let reason: string | null = null;
      try {
        if (repository instanceof Promise) {
          const choice = await repository;
          repo = choice.repository;
          reason = choice.reason;
        } else if (repository) repo = repository;
        const data = await repo.load();
        if (!cancelled) setBoot({ repository: repo, data, reason });
      } catch (err) {
        const fallback = new InMemoryRepository();
        const message = err instanceof Error ? err.message : String(err);
        if (!cancelled) setBoot({ repository: fallback, data: fallback.load(), reason: `${repo.kind} repository failed to load (${message}) — running in memory` });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boot, repository]);

  if (!boot) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas text-[13px] text-muted" role="status">
        Loading Website OS…
      </div>
    );
  }
  return (
    <OSStoreInner repository={boot.repository} initial={boot.data} reason={boot.reason} user={user} gateway={gateway}>
      {children}
    </OSStoreInner>
  );
}

function OSStoreInner({ children, repository, initial, reason, user, gateway }: { children: React.ReactNode; repository: OSRepository; initial: OSData; reason: string | null; user: AuthUser; gateway?: GatewayClient }) {
  const [data, dispatch] = React.useReducer(reducer, initial);
  const [persistError, setPersistError] = React.useState<string | null>(null);
  const dataRef = React.useRef(data);
  dataRef.current = data;
  const userRef = React.useRef(user);
  userRef.current = user;

  const gatewayClient = React.useMemo<GatewayClient>(() => gateway ?? new EmbeddedGatewayClient({ getData: () => dataRef.current, getUser: () => userRef.current }), [gateway]);
  // Audit jobs need live providers. In Supabase mode that is the same HTTP gateway; in local dev the
  // Vite middleware serves the local gateway (CTOS_LOCAL_NO_SUPABASE=1) with the job truth posted
  // alongside. Production builds without Supabase keep the embedded stub gateway, labelled as such.
  const auditGateway = React.useMemo<GatewayClient>(() => (gateway ? gateway : import.meta.env.DEV ? new HttpGatewayClient("/agent-execute", async () => "local-session") : gatewayClient), [gateway, gatewayClient]);

  React.useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => repository.persist(data))
      .then(() => active && setPersistError(null))
      .catch((err: unknown) => active && setPersistError(err instanceof Error ? err.message : String(err)));
    return () => {
      active = false;
    };
  }, [data, repository]);

  const actions = React.useMemo<OSStoreValue["actions"]>(() => {
    const actor = () => userRef.current;
    return {
      createProject: (input) => {
        const ids = { clientId: newId("client"), projectId: newId("proj"), ticketId: newId("t") };
        dispatch({ type: "CREATE_PROJECT", input, ids, actor: actor() });
        return { projectId: ids.projectId, clientId: ids.clientId };
      },
      transitionProject: (projectId, to) => dispatch({ type: "TRANSITION_PROJECT", projectId, to, actor: actor() }),
      setTicketStatus: (ticketId, status) => dispatch({ type: "SET_TICKET_STATUS", ticketId, status, actor: actor() }),
      setTicketApproval: (ticketId, approval) => dispatch({ type: "SET_TICKET_APPROVAL", ticketId, approval, actor: actor() }),
      runTicket: async (ticketId) => {
        const snapshot = dataRef.current;
        const user = actor();
        const ticket = snapshot.tickets.find((t) => t.id === ticketId);
        if (!ticket) return { kind: "skipped", reason: "Ticket not found" };
        const state = ticketRunState(snapshot, ticketId, user);
        if (state.inFlight) return { kind: "skipped", reason: "A job is already in flight for this ticket" };
        const jobId = state.job?.id ?? newId("job");
        const handoffId = newId("handoff");
        // Plan on the same snapshot the reducer will start from, so we know whether execution may proceed.
        const started = reducer(snapshot, { type: "RUN_TICKET_START", ticketId, jobId, handoffId, actor: user });
        dispatch({ type: "RUN_TICKET_START", ticketId, jobId, handoffId, actor: user });
        const job = started.agentJobs.find((j) => j.id === jobId);
        if (!job || job.status !== "RUNNING") {
          const agent = snapshot.agents.find((a) => a.id === ticket.agentId);
          const level = job && agent ? effectiveLevel(job.permissionLevel, agent.permissionLevel) : "GREEN";
          const check = job ? checkPermission({ level, user, job, approvals: started.jobApprovals }) : null;
          return level === "GREEN" ? { kind: "skipped", reason: check?.reason ?? "Cannot run" } : { kind: "needs_approval", level, reason: check?.reason ?? "Approval required" };
        }
        // Server-side truth must contain the RUNNING job before the gateway reads it.
        try {
          await repository.persist(started);
        } catch {
          /* persistence errors surface in Settings; the gateway will report not_found if the job is missing */
        }
        const response = await gatewayClient.execute(jobId, { artifactTitle: `${ticket.title} — ${job.requiredOutputSchema.split("@")[0].replace(/_/g, " ")}` });
        dispatch({ type: "APPLY_EXECUTION", jobId, response, actor: user });
        return { kind: "executed", response };
      },
      runQA: (projectId) => dispatch({ type: "RUN_QA", projectId, ticketId: newId("t"), qaRunId: newId("qarun"), actor: actor() }),
      decideApproval: (approvalId, status, notes) => dispatch({ type: "DECIDE_APPROVAL", approvalId, status, notes, actor: actor() }),
      decideJobApproval: (approvalId, decision, note) => dispatch({ type: "DECIDE_JOB_APPROVAL", approvalId, decision, note, actor: actor() }),
      authorizeJob: (jobId) => dispatch({ type: "AUTHORIZE_JOB", jobId, actor: actor() }),
      toggleHold: (holdId) => dispatch({ type: "TOGGLE_HOLD", holdId, actor: actor() }),
      setQAItemStatus: (qaItemId, status) => dispatch({ type: "SET_QA_ITEM_STATUS", qaItemId, status, actor: actor() }),
      cancelJob: (jobId, reason) => dispatch({ type: "CANCEL_JOB", jobId, reason, actor: actor() }),
      reviewKnowledge: (itemId, decision, opts) => dispatch({ type: "REVIEW_KNOWLEDGE", itemId, decision, scope: opts?.scope, projectId: opts?.projectId, actor: actor() }),
      proposeLesson: (input) => dispatch({ type: "PROPOSE_LESSON", input, actor: actor() }),
      setAgentProvider: (agentId, policy) => dispatch({ type: "SET_AGENT_PROVIDER", agentId, policy, actor: actor() }),
      note: (projectId, message) => dispatch({ type: "NOTE", projectId, message, actor: actor() }),
      createExternalClient: (input) => {
        const id = newId("ext");
        const rawToken = generateExternalClientToken();
        dispatch({ type: "CREATE_EXTERNAL_CLIENT", id, rawToken, name: input.name, clientType: input.type, permissionCeiling: input.permissionCeiling, actor: actor() });
        return { id, rawToken };
      },
      setExternalClientStatus: (clientId, status) => dispatch({ type: "SET_EXTERNAL_CLIENT_STATUS", clientId, status, actor: actor() }),
      rotateExternalClientToken: (clientId) => {
        const rawToken = generateExternalClientToken();
        dispatch({ type: "ROTATE_EXTERNAL_CLIENT_TOKEN", clientId, rawToken, actor: actor() });
        return { rawToken };
      },
      revokeExternalClient: (clientId) => dispatch({ type: "REVOKE_EXTERNAL_CLIENT", clientId, actor: actor() }),
      // CTOS-007A: Website Audit Engine
      startAudit: async (targetUrl, auditType, projectId) => {
        const user = actor();
        const requestId = newId("audit");
        // Async orchestration cannot read dataRef (it only updates on render): keep a local snapshot
        // advanced through the same reducer, exactly as runTicket plans on its own snapshot.
        let snapshot = reducer(dataRef.current, { type: "CREATE_AUDIT_REQUEST", requestId, targetUrl, auditType, projectId, actor: user });
        dispatch({ type: "CREATE_AUDIT_REQUEST", requestId, targetUrl, auditType, projectId, actor: user });
        if (!snapshot.websiteAuditRequests.some((r) => r.id === requestId)) return { ok: false, reason: "URL rejected: only public http(s) domains can be audited." };
        const apply = (action: Action) => {
          snapshot = reducer(snapshot, action);
          dispatch(action);
          return snapshot;
        };
        await runAuditPipeline({
          requestId,
          user,
          apply,
          snapshot: () => snapshot,
          gateway: auditGateway,
          fallbackGateway: auditGateway === gatewayClient ? undefined : gatewayClient,
          capture: captureViaServer,
          persist: gatewayClient.kind === "http" && gatewayClient === auditGateway ? async (d) => { await repository.persist(d); } : undefined,
          newId,
        });
        return { ok: true, requestId };
      },
      markAuditReviewed: (requestId) => dispatch({ type: "AUDIT_REVIEWED", requestId, actor: actor() }),
    };
  }, [gatewayClient, auditGateway, repository]);

  const status = React.useMemo<StoreStatus>(
    () => ({ repositoryKind: repository.kind, description: repository.describe?.() ?? repository.kind, reason, persistError, gatewayKind: gatewayClient.kind }),
    [repository, reason, persistError, gatewayClient],
  );

  const value = React.useMemo(() => ({ data, user, actions, repositoryKind: repository.kind, status, gateway: gatewayClient }), [data, user, actions, repository.kind, status, gatewayClient]);
  return <OSStoreContext.Provider value={value}>{children}</OSStoreContext.Provider>;
}

/** Exported for tests: run the reducer directly without React. */
export function reduceOS(data: OSData, action: Action): OSData {
  return reducer(data, action);
}
export type OSAction = Action;

export function useOS(): OSStoreValue {
  const ctx = React.useContext(OSStoreContext);
  if (!ctx) throw new Error("useOS must be used inside <OSStoreProvider>");
  return ctx;
}

// ---------------------------------------------------------------------------
// Selectors (derived views — keep components free of data logic)
// ---------------------------------------------------------------------------

export function useProject(projectId: string) {
  const { data } = useOS();
  return React.useMemo(() => {
    const project = data.projects.find((p) => p.id === projectId) ?? null;
    if (!project) return null;
    const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order;
    const tickets = data.tickets.filter((t) => t.projectId === projectId).sort(byOrder);
    return {
      project,
      client: data.clients.find((c) => c.id === project.clientId) ?? null,
      phases: data.phases.filter((p) => p.projectId === projectId).sort(byOrder),
      pages: data.pages.filter((p) => p.projectId === projectId),
      tickets,
      artifacts: data.artifacts.filter((a) => a.projectId === projectId),
      qaItems: data.qaItems.filter((q) => q.projectId === projectId),
      launchHolds: data.launchHolds.filter((h) => h.projectId === projectId),
      approvals: data.approvals.filter((a) => a.projectId === projectId),
      activity: data.activity.filter((a) => a.projectId === projectId).sort((a, b) => b.order - a.order),
      jobs: data.agentJobs.filter((j) => j.projectId === projectId),
      runs: data.agentRuns.filter((r) => r.projectId === projectId),
      handoffs: data.handoffs.filter((h) => h.projectId === projectId),
      qaRuns: data.qaRuns.filter((r) => r.projectId === projectId),
      knowledge: data.knowledgeItems.filter((k) => k.projectId === projectId),
      currentTicket: tickets.find((t) => t.status === "BUILDING" || t.status === "REVIEW") ?? null,
      lastCompletedTicket: [...tickets].reverse().find((t) => t.status === "COMPLETE") ?? null,
      nextTicket: tickets.find((t) => t.status === "QUEUED" || t.status === "READY") ?? null,
    };
  }, [data, projectId]);
}

export function useDashboardStats() {
  const { data } = useOS();
  return React.useMemo(() => {
    const active = data.projects.filter((p) => p.state !== "ARCHIVED" && p.state !== "LIVE" && p.state !== "MAINTENANCE");
    return {
      activeProjects: active.length,
      inBuild: data.projects.filter((p) => p.state === "BUILDING" || p.state === "READY_TO_BUILD").length,
      awaitingApproval: data.approvals.filter((a) => a.status === "PENDING").length + data.tickets.filter((t) => t.approvalState === "PENDING").length,
      qaIssues: data.qaItems.filter((q) => q.status === "OPEN" || q.status === "IN_PROGRESS").length,
      readyToLaunch: data.projects.filter((p) => p.state === "READY_TO_LAUNCH").length,
      knowledgeCandidates: data.knowledgeItems.filter((k) => k.status === "CANDIDATE").length,
      runningJobs: data.agentJobs.filter((j) => j.status === "RUNNING").length,
    };
  }, [data]);
}

export function qaSeverityCounts(items: QAItem[]) {
  const open = items.filter((q) => q.status === "OPEN" || q.status === "IN_PROGRESS");
  return {
    P0: open.filter((q) => q.severity === "P0").length,
    P1: open.filter((q) => q.severity === "P1").length,
    P2: open.filter((q) => q.severity === "P2").length,
    P3: open.filter((q) => q.severity === "P3").length,
    total: open.length,
  };
}

export function agentById(data: OSData, id?: string | null) {
  return id ? (data.agents.find((a) => a.id === id) ?? null) : null;
}

export function pendingLaunchApproval(approvals: Approval[]) {
  return approvals.find((a) => a.gate === "LAUNCH" && a.status === "PENDING") ?? null;
}

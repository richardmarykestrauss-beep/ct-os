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
import type { AgentProviderPolicy, KnowledgeScope, QARun } from "@/data/types";
import { PHASES, PROJECT_STATE_LABELS, STATE_PROGRESS, canTransition } from "@/data/state-machine";
import { AGENT_IDS } from "@/data/seed";
import { InMemoryRepository, type OSRepository, type RepositoryChoice } from "@/services/repository";
import { createArtifact } from "@/services/artifacts";
import { applyJobFailure, applyJobResult, approveJobOutput, buildProviderRequest, cancelJob, createJobForTicket, requestJobRevision, startJob } from "@/services/agent-jobs";
import { proposeLesson, reviewKnowledgeItem, type ProposeLessonInput, type ReviewDecision } from "@/services/knowledge";
import { ModelRouter } from "@/ai/router";
import { createDefaultRegistry, PROVIDER_LABELS } from "@/ai/registry";
import type { RouterResult } from "@/ai/types";
import { newId, nowIso } from "@/lib/utils";

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

type Action =
  | { type: "CREATE_PROJECT"; input: NewProjectInput; ids: { clientId: string; projectId: string; ticketId: string } }
  | { type: "TRANSITION_PROJECT"; projectId: string; to: ProjectState }
  | { type: "SET_TICKET_STATUS"; ticketId: string; status: TicketStatus }
  | { type: "SET_TICKET_APPROVAL"; ticketId: string; approval: TicketApprovalState }
  | { type: "RUN_TICKET_START"; ticketId: string; jobId: string }
  | { type: "RUN_TICKET_RESULT"; jobId: string; result: RouterResult | null; error: string | null }
  | { type: "RUN_QA"; projectId: string; ticketId: string; qaRunId: string }
  | { type: "CANCEL_JOB"; jobId: string; reason?: string }
  | { type: "REVIEW_KNOWLEDGE"; itemId: string; decision: ReviewDecision; scope?: Exclude<KnowledgeScope, "TASK">; projectId?: string | null }
  | { type: "PROPOSE_LESSON"; input: ProposeLessonInput }
  | { type: "SET_AGENT_PROVIDER"; agentId: string; policy: Partial<AgentProviderPolicy> }
  | { type: "DECIDE_APPROVAL"; approvalId: string; status: ApprovalStatus; notes?: string }
  | { type: "TOGGLE_HOLD"; holdId: string }
  | { type: "SET_QA_ITEM_STATUS"; qaItemId: string; status: QAItem["status"] }
  | { type: "NOTE"; projectId: string | null; message: string };

const ACTOR = "Production Lead";

function pushActivity(data: OSData, projectId: string | null, kind: ActivityKind, message: string, ref?: string, actor = ACTOR): ActivityEvent[] {
  const order = data.activity.reduce((m, a) => Math.max(m, a.order), 0) + 1;
  return [...data.activity, { id: newId("act"), projectId, kind, ref, message, actor, at: nowIso(), order }];
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
          { id: newId("appr"), projectId: project.id, gate: "STRATEGY", requestedBy: "Orchestrator", status: "PENDING", decidedAt: null, createdAt: now },
        ],
      };
      next = createArtifact(next, { projectId: project.id, type: "project_brief", title: "Project Brief", createdByAgentId: AGENT_IDS.ORCH, status: "FINAL", summary: input.primaryGoal, at: now }).data;
      next = { ...next, activity: pushActivity(next, project.id, "PROJECT_CREATED", `Project created — ${project.name} (${platformSummary})`) };
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
      return { ...next, activity: pushActivity(next, project.id, "STATE_CHANGED", `State changed ${PROJECT_STATE_LABELS[project.state]} → ${PROJECT_STATE_LABELS[action.to]}`) };
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
      return { ...next, activity: pushActivity(next, ticket.projectId, kind, `${ticket.code} → ${action.status === "COMPLETE" ? "completed" : action.status.toLowerCase()} — ${ticket.title}`, ticket.code) };
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
        next = { ...next, activity: pushActivity(next, ticket.projectId, "JOB", `Job output approved — artifact finalised`, ticket.code) };
      } else if (job && action.approval === "NEEDS_REVISION") {
        next = requestJobRevision(next, job.id, "Needs revision (human review)").data;
        next = { ...next, activity: pushActivity(next, ticket.projectId, "JOB", `Job re-queued for revision`, ticket.code) };
      }
      const msg = action.approval === "APPROVED" ? "approved" : action.approval === "NEEDS_REVISION" ? "sent back — needs revision" : "awaiting approval";
      return { ...next, activity: pushActivity(next, ticket.projectId, "APPROVAL", `${ticket.code} ${msg} — ${ticket.title}`, ticket.code) };
    }

    case "RUN_TICKET_START": {
      // Real job model, stub intelligence: a job is created (or an existing QUEUED job re-used),
      // routed through the ModelRouter, and its output becomes a versioned artifact for human review.
      const ticket = data.tickets.find((t) => t.id === action.ticketId);
      if (!ticket) return data;
      // One job in flight per ticket: a second click while RUNNING / WAITING_APPROVAL is a no-op.
      if (data.agentJobs.some((j) => j.ticketId === ticket.id && (j.status === "RUNNING" || j.status === "WAITING_APPROVAL"))) return data;
      const now = nowIso();
      let next: OSData = data;
      const existing = next.agentJobs.find((j) => j.ticketId === ticket.id && j.status === "QUEUED");
      // The action pre-computed its provider request for `action.jobId`; if the store disagrees, do nothing.
      if (existing && existing.id !== action.jobId) return data;
      const jobId = action.jobId;
      if (!existing) next = createJobForTicket(next, ticket, { id: action.jobId, at: now }).data;
      next = startJob(next, jobId).data;
      const job = next.agentJobs.find((j) => j.id === jobId)!;
      next = { ...next, tickets: next.tickets.map((t) => (t.id === ticket.id ? { ...t, status: "BUILDING" as TicketStatus, updatedAt: now } : t)), projects: touchProject(next.projects, ticket.projectId, { nextAction: `Wait for ${ticket.code} to finish` }) };
      next = { ...next, agents: syncAgent(next, ticket.agentId, ticket.id, "BUILDING") };
      next = { ...next, activity: pushActivity(next, ticket.projectId, "JOB", `${ticket.code} job started — preferred provider ${PROVIDER_LABELS[job.preferredProvider]}${job.inputArtifactIds.length ? ` · ${job.inputArtifactIds.length} input artifact(s)` : ""}`, ticket.code, "Orchestrator") };
      return next;
    }

    case "RUN_TICKET_RESULT": {
      const job = data.agentJobs.find((j) => j.id === action.jobId);
      if (!job || job.status !== "RUNNING") return data;
      const ticket = job.ticketId ? data.tickets.find((t) => t.id === job.ticketId) : null;
      const now = nowIso();
      let next: OSData = data;
      if (action.result) {
        const result = action.result;
        const applied = applyJobResult(next, job.id, result, { artifactTitle: ticket ? `${ticket.title} — ${job.requiredOutputSchema.split("@")[0].replace(/_/g, " ")}` : undefined });
        next = applied.data;
        const artifact = next.artifacts.find((a) => a.id === applied.artifactId);
        if (ticket) {
          next = {
            ...next,
            tickets: next.tickets.map((t) =>
              t.id === ticket.id
                ? {
                    ...t,
                    status: "REVIEW" as TicketStatus,
                    approvalState: "PENDING" as TicketApprovalState,
                    executionOutput: `${result.response.summary}\n\nOutput artifact: ${artifact?.title ?? applied.artifactId} (v${artifact?.version ?? 1}).`,
                    safetyCheck: "Stub provider — no external systems touched.",
                    updatedAt: now,
                  }
                : t,
            ),
            projects: touchProject(next.projects, ticket.projectId, { nextAction: `Review ${ticket.code} output` }),
          };
          next = { ...next, agents: syncAgent(next, ticket.agentId, ticket.id, "REVIEW") };
        }
        const providerLabel = PROVIDER_LABELS[result.providerId];
        const fellBack = result.providerId !== job.preferredProvider;
        next = { ...next, activity: pushActivity(next, job.projectId, "ARTIFACT", `${artifact?.title ?? "Artifact"} v${artifact?.version ?? 1} produced by ${providerLabel}${fellBack ? ` (fallback from ${PROVIDER_LABELS[job.preferredProvider]})` : ""} — waiting for review`, ticket?.code, "Orchestrator") };
        return next;
      }
      const failed = applyJobFailure(next, job.id, new Error(action.error ?? "Provider execution failed"));
      next = failed.data;
      if (ticket) {
        next = {
          ...next,
          tickets: next.tickets.map((t) => (t.id === ticket.id ? { ...t, status: "BLOCKED" as TicketStatus, warnings: [...t.warnings, `Job failed: ${action.error ?? "unknown error"}`], updatedAt: now } : t)),
          projects: touchProject(next.projects, ticket.projectId, { nextAction: `Resolve failed job on ${ticket.code}` }),
        };
        next = { ...next, agents: syncAgent(next, ticket.agentId, ticket.id, "BLOCKED") };
      }
      return { ...next, activity: pushActivity(next, job.projectId, "JOB", `Job failed — ${action.error ?? "no provider available"}`, ticket?.code, "Orchestrator") };
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
      next = { ...next, activity: pushActivity(next, project.id, "QA_RUN", `${code} QA run (mock) — ${open} open defect${open === 1 ? "" : "s"}`, code, "06 QA Auditor") };
      return next;
    }

    case "DECIDE_APPROVAL": {
      const approval = data.approvals.find((a) => a.id === action.approvalId);
      if (!approval) return data;
      const now = nowIso();
      const approvals = data.approvals.map((a) =>
        a.id === approval.id ? { ...a, status: action.status, notes: action.notes ?? a.notes, decidedBy: action.status === "PENDING" ? undefined : ACTOR, decidedAt: action.status === "PENDING" ? null : now } : a,
      );
      let next: OSData = { ...data, approvals, projects: touchProject(data.projects, approval.projectId) };
      if (approval.gate === "LAUNCH") {
        const orchStatus: Agent["status"] = action.status === "APPROVED" ? "IDLE" : action.status === "CHANGES_REQUESTED" ? "BLOCKED" : "WAITING_APPROVAL";
        next = { ...next, agents: next.agents.map((a) => (a.id === AGENT_IDS.ORCH ? { ...a, status: orchStatus, statusDetail: action.status === "APPROVED" ? "Launch approved" : action.status === "CHANGES_REQUESTED" ? "Launch changes requested" : "Human Review" } : a)) };
      }
      const label = action.status === "APPROVED" ? "approved" : action.status === "CHANGES_REQUESTED" ? "changes requested" : "reset to pending";
      return { ...next, activity: pushActivity(next, approval.projectId, "APPROVAL", `${approval.gate.replace("_", " ")} gate ${label}`, approval.gate) };
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
      return { ...next, activity: pushActivity(next, hold.projectId, "HOLD", `Launch hold ${resolved ? "resolved" : "reopened"} — ${hold.title}`) };
    }

    case "SET_QA_ITEM_STATUS": {
      const item = data.qaItems.find((q) => q.id === action.qaItemId);
      if (!item) return data;
      const now = nowIso();
      const qaItems = data.qaItems.map((q) => (q.id === item.id ? { ...q, status: action.status, resolvedAt: action.status === "FIXED" || action.status === "VERIFIED" ? now : null } : q));
      const next: OSData = { ...data, qaItems, projects: touchProject(data.projects, item.projectId) };
      return { ...next, activity: pushActivity(next, item.projectId, "QA_FIX", `QA item ${action.status.toLowerCase()} — ${item.title}`) };
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
      return { ...next, activity: pushActivity(next, job.projectId, "JOB", `Job cancelled${action.reason ? ` — ${action.reason}` : ""}`, ticket?.code) };
    }

    case "REVIEW_KNOWLEDGE": {
      try {
        const r = reviewKnowledgeItem(data, { kind: "human", name: ACTOR }, action.itemId, action.decision, { scope: action.scope, projectId: action.projectId });
        const label = action.decision === "APPROVED" ? "approved" : action.decision === "REJECTED" ? "rejected" : "deprecated";
        return { ...r.data, activity: pushActivity(r.data, r.item.projectId, "KNOWLEDGE", `Knowledge ${label} — ${r.item.title} [${r.item.scope}]`) };
      } catch {
        return data;
      }
    }

    case "PROPOSE_LESSON": {
      try {
        const r = proposeLesson(data, action.input);
        const agent = data.agents.find((a) => a.id === action.input.agentId);
        return { ...r.data, activity: pushActivity(r.data, action.input.projectId, "KNOWLEDGE", `Lesson candidate proposed — ${r.item.title}`, undefined, agent ? `${agent.shortCode} ${agent.name}` : ACTOR) };
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
      return { ...next, activity: pushActivity(next, null, "AGENT", `${agent.shortCode} ${agent.name} — provider policy: ${PROVIDER_LABELS[policy.preferred]}${policy.fallbacks.length ? ` → ${policy.fallbacks.map((p) => PROVIDER_LABELS[p]).join(" → ")}` : ""}`) };
    }

    case "NOTE": {
      return { ...data, activity: pushActivity(data, action.projectId, "NOTE", action.message) };
    }
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
  /** Human description of the store, e.g. "In-memory (session only)". */
  description: string;
  /** Why this repository was chosen (from createRepository), if known. */
  reason: string | null;
  /** Last persistence error, if any. */
  persistError: string | null;
}

interface OSStoreValue {
  data: OSData;
  repositoryKind: OSRepository["kind"];
  status: StoreStatus;
  router: ModelRouter;
  actions: {
    createProject: (input: NewProjectInput) => { projectId: string; clientId: string };
    transitionProject: (projectId: string, to: ProjectState) => void;
    setTicketStatus: (ticketId: string, status: TicketStatus) => void;
    setTicketApproval: (ticketId: string, approval: TicketApprovalState) => void;
    /** Creates/starts the ticket's job, routes it through the ModelRouter, records runs + artifact. */
    runTicket: (ticketId: string) => Promise<void>;
    runQA: (projectId: string) => void;
    decideApproval: (approvalId: string, status: ApprovalStatus, notes?: string) => void;
    toggleHold: (holdId: string) => void;
    setQAItemStatus: (qaItemId: string, status: QAItem["status"]) => void;
    cancelJob: (jobId: string, reason?: string) => void;
    reviewKnowledge: (itemId: string, decision: ReviewDecision, opts?: { scope?: Exclude<KnowledgeScope, "TASK">; projectId?: string | null }) => void;
    proposeLesson: (input: ProposeLessonInput) => void;
    setAgentProvider: (agentId: string, policy: Partial<AgentProviderPolicy>) => void;
    note: (projectId: string | null, message: string) => void;
  };
}

const OSStoreContext = React.createContext<OSStoreValue | null>(null);

export function createDefaultRouter() {
  return new ModelRouter({ registry: createDefaultRegistry() });
}

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
 * Boots the repository (sync for in-memory, async for Supabase), then mounts the store.
 * If a persistent repository fails to load, CT-OS falls back to the in-memory seed and says so.
 */
export function OSStoreProvider({
  children,
  repository,
  router,
}: {
  children: React.ReactNode;
  repository?: OSRepository | Promise<RepositoryChoice>;
  router?: ModelRouter;
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

  const routerInstance = React.useMemo(() => router ?? createDefaultRouter(), [router]);

  if (!boot) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas text-[13px] text-muted" role="status">
        Loading Website OS…
      </div>
    );
  }
  return (
    <OSStoreInner repository={boot.repository} initial={boot.data} reason={boot.reason} router={routerInstance}>
      {children}
    </OSStoreInner>
  );
}

function OSStoreInner({ children, repository, initial, reason, router }: { children: React.ReactNode; repository: OSRepository; initial: OSData; reason: string | null; router: ModelRouter }) {
  const [data, dispatch] = React.useReducer(reducer, initial);
  const [persistError, setPersistError] = React.useState<string | null>(null);
  const dataRef = React.useRef(data);
  dataRef.current = data;

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

  const actions = React.useMemo<OSStoreValue["actions"]>(
    () => ({
      createProject: (input) => {
        const ids = { clientId: newId("client"), projectId: newId("proj"), ticketId: newId("t") };
        dispatch({ type: "CREATE_PROJECT", input, ids });
        return { projectId: ids.projectId, clientId: ids.clientId };
      },
      transitionProject: (projectId, to) => dispatch({ type: "TRANSITION_PROJECT", projectId, to }),
      setTicketStatus: (ticketId, status) => dispatch({ type: "SET_TICKET_STATUS", ticketId, status }),
      setTicketApproval: (ticketId, approval) => dispatch({ type: "SET_TICKET_APPROVAL", ticketId, approval }),
      runTicket: async (ticketId) => {
        const snapshot = dataRef.current;
        const ticket = snapshot.tickets.find((t) => t.id === ticketId);
        if (!ticket) return;
        if (snapshot.agentJobs.some((j) => j.ticketId === ticket.id && (j.status === "RUNNING" || j.status === "WAITING_APPROVAL"))) return;
        const existing = snapshot.agentJobs.find((j) => j.ticketId === ticket.id && j.status === "QUEUED");
        const jobId = existing?.id ?? newId("job");
        // Build the provider request from the same snapshot the reducer will start from.
        const planned = existing ? snapshot : createJobForTicket(snapshot, ticket, { id: jobId }).data;
        const job = planned.agentJobs.find((j) => j.id === jobId)!;
        const request = buildProviderRequest(planned, job);
        dispatch({ type: "RUN_TICKET_START", ticketId, jobId });
        try {
          const result = await router.execute(job, request);
          dispatch({ type: "RUN_TICKET_RESULT", jobId, result, error: null });
        } catch (err) {
          dispatch({ type: "RUN_TICKET_RESULT", jobId, result: null, error: err instanceof Error ? err.message : String(err) });
        }
      },
      runQA: (projectId) => dispatch({ type: "RUN_QA", projectId, ticketId: newId("t"), qaRunId: newId("qarun") }),
      decideApproval: (approvalId, status, notes) => dispatch({ type: "DECIDE_APPROVAL", approvalId, status, notes }),
      toggleHold: (holdId) => dispatch({ type: "TOGGLE_HOLD", holdId }),
      setQAItemStatus: (qaItemId, status) => dispatch({ type: "SET_QA_ITEM_STATUS", qaItemId, status }),
      cancelJob: (jobId, reason) => dispatch({ type: "CANCEL_JOB", jobId, reason }),
      reviewKnowledge: (itemId, decision, opts) => dispatch({ type: "REVIEW_KNOWLEDGE", itemId, decision, scope: opts?.scope, projectId: opts?.projectId }),
      proposeLesson: (input) => dispatch({ type: "PROPOSE_LESSON", input }),
      setAgentProvider: (agentId, policy) => dispatch({ type: "SET_AGENT_PROVIDER", agentId, policy }),
      note: (projectId, message) => dispatch({ type: "NOTE", projectId, message }),
    }),
    [router],
  );

  const status = React.useMemo<StoreStatus>(
    () => ({ repositoryKind: repository.kind, description: repository.describe?.() ?? repository.kind, reason, persistError }),
    [repository, reason, persistError],
  );

  const value = React.useMemo(() => ({ data, actions, repositoryKind: repository.kind, status, router }), [data, actions, repository.kind, status, router]);
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

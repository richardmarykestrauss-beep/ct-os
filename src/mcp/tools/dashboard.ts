/**
 * CTOS-004 Part I — `ctos.dashboard.summary`: an operations snapshot across every project,
 * specifically shaped for an external assistant acting as Richard's "eyes on operations."
 */
import { z } from "zod";
import { readOnly, type McpToolDef } from "../types";

export const dashboardSummary: McpToolDef<Record<string, never>> = readOnly({
  name: "ctos.dashboard.summary",
  title: "Operations dashboard summary",
  description: "Cross-project operations snapshot: active projects, projects needing attention, pending approvals, QA failures, launch holds, active/failed agent work, provider health and latest client feedback.",
  schema: z.object({}),
  handler: async (ctx) => {
    const d = ctx.store.data;

    const activeProjects = d.projects.filter((p) => p.state !== "ARCHIVED");

    const projectsNeedingAttention = activeProjects
      .filter((p) => {
        const hasOpenHold = d.launchHolds.some((h) => h.projectId === p.id && !h.resolved);
        const hasP0P1Qa = d.qaItems.some((q) => q.projectId === p.id && (q.status === "OPEN" || q.status === "IN_PROGRESS") && (q.severity === "P0" || q.severity === "P1"));
        const hasPendingApproval = d.approvals.some((a) => a.projectId === p.id && a.status === "PENDING") || d.jobApprovals.some((a) => a.projectId === p.id && a.status === "PENDING");
        return hasOpenHold || hasP0P1Qa || hasPendingApproval;
      })
      .map((p) => ({ id: p.id, name: p.name, state: p.state, statusLabel: p.statusLabel }));

    const pendingApprovals = { gate: d.approvals.filter((a) => a.status === "PENDING").length, job: d.jobApprovals.filter((a) => a.status === "PENDING").length };

    const qaFailures = d.qaRuns
      .filter((r) => r.result === "FAIL" || r.result === "ISSUES_FOUND")
      .slice(-10)
      .reverse()
      .map((r) => ({ id: r.id, projectId: r.projectId, result: r.result, counts: r.counts, finishedAt: r.finishedAt }));

    const openLaunchHolds = d.launchHolds.filter((h) => !h.resolved).map((h) => ({ id: h.id, projectId: h.projectId, title: h.title, owner: h.owner }));

    const activeAgentJobs = d.agentJobs.filter((j) => j.status === "RUNNING" || j.status === "WAITING_APPROVAL").map((j) => ({ id: j.id, projectId: j.projectId, agentId: j.agentId, status: j.status, taskType: j.taskType }));

    const failedAgentRuns = d.agentRuns
      .filter((r) => r.status === "FAILED" || r.status === "FAILED_VALIDATION")
      .slice(-10)
      .reverse()
      .map((r) => ({ id: r.id, jobId: r.jobId, agentId: r.agentId, providerId: r.providerId, status: r.status, error: r.error ?? null, finishedAt: r.finishedAt }));

    const providerStatus = await ctx.registry.status();

    const latestClientFeedback = d.artifacts
      .filter((a) => a.type === "client_feedback")
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, 5)
      .map((a) => ({ id: a.id, projectId: a.projectId, title: a.title, summary: a.summary ?? null, createdAt: a.createdAt }));

    const result = {
      activeProjects: activeProjects.map((p) => ({ id: p.id, name: p.name, state: p.state, statusLabel: p.statusLabel })),
      projectsNeedingAttention,
      pendingApprovals,
      qaFailures,
      openLaunchHolds,
      activeAgentJobs,
      failedAgentRuns,
      providerHealth: providerStatus.map((p) => ({ id: p.id, label: p.label, state: p.state, available: p.available })),
      latestClientFeedback,
    };
    return { result, requestedAction: "read operations dashboard summary" };
  },
});

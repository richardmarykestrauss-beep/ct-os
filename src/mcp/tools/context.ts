/**
 * CTOS-004 Part G — `ctos.context.project`: a single compressed, token-efficient context pack for
 * one project. This is the preferred way an external assistant learns what is going on with a
 * project, instead of chaining several read tools together.
 */
import { z } from "zod";
import { readOnly, type McpToolDef } from "../types";

const INPUT = z.object({ projectId: z.string().min(1) });

export const contextProject: McpToolDef<{ projectId: string }> = readOnly({
  name: "ctos.context.project",
  title: "Project context pack",
  description: "Compressed authoritative context for one project: identity, goal, phase, open tickets, blockers, recent decisions, doctrine/skills relevant to the work, latest key artifacts and the recommended next action. Prefer this over chaining several read tools.",
  schema: INPUT,
  handler: (ctx, { projectId }) => {
    const d = ctx.store.data;
    const project = d.projects.find((p) => p.id === projectId);
    if (!project) return { result: { ok: false, error: `project ${projectId} not found` }, requestedAction: `get context for project ${projectId}`, projectId };
    const client = d.clients.find((c) => c.id === project.clientId) ?? null;

    const openTickets = d.tickets
      .filter((t) => t.projectId === projectId && t.status !== "COMPLETE")
      .sort((a, b) => a.order - b.order)
      .slice(0, 8)
      .map((t) => ({ code: t.code, title: t.title, phase: t.phase, status: t.status, priority: t.priority }));

    const openHolds = d.launchHolds.filter((h) => h.projectId === projectId && !h.resolved).map((h) => ({ title: h.title, owner: h.owner, detail: h.detail ?? null }));
    const openQaP0P1 = d.qaItems.filter((q) => q.projectId === projectId && (q.status === "OPEN" || q.status === "IN_PROGRESS") && (q.severity === "P0" || q.severity === "P1")).length;

    const recentDecisions = d.activity
      .filter((a) => a.projectId === projectId && (a.kind === "APPROVAL" || a.kind === "STATE_CHANGED" || a.kind === "HOLD"))
      .sort((a, b) => b.order - a.order)
      .slice(0, 6)
      .map((a) => ({ kind: a.kind, message: a.message, actor: a.actor, at: a.at }));

    const projectKnowledge = d.knowledgeItems
      .filter((k) => k.status === "APPROVED" && k.scope === "PROJECT" && k.projectId === projectId)
      .slice(0, 6)
      .map((k) => ({ title: k.title, content: k.content }));
    const doctrine = d.knowledgeItems
      .filter((k) => k.status === "APPROVED" && k.scope === "DOCTRINE")
      .slice(0, 6)
      .map((k) => ({ title: k.title, content: k.content }));
    const skills = d.skills
      .filter((s) => s.status === "APPROVED")
      .slice(0, 6)
      .map((s) => ({ name: s.name, version: s.version, kind: s.kind }));

    const latestArtifactsByType = new Map<string, (typeof d.artifacts)[number]>();
    for (const a of d.artifacts) {
      if (a.projectId !== projectId || a.status === "SUPERSEDED" || a.status === "REJECTED") continue;
      const existing = latestArtifactsByType.get(a.type);
      if (!existing || a.version > existing.version) latestArtifactsByType.set(a.type, a);
    }
    const latestArtifacts = [...latestArtifactsByType.values()].map((a) => ({ type: a.type, title: a.title, version: a.version, status: a.status, summary: a.summary ?? null }));

    const result = {
      identity: { projectId: project.id, projectName: project.name, clientName: client?.name ?? null },
      goal: project.primaryGoal ?? null,
      currentPhase: { key: project.currentPhase, state: project.state, statusLabel: project.statusLabel, progress: project.progress },
      criticalFacts: projectKnowledge,
      currentTickets: openTickets,
      openBlockers: { launchHolds: openHolds, openQaP0P1Count: openQaP0P1 },
      recentDecisions,
      approvedDoctrine: doctrine,
      approvedSkills: skills,
      latestKeyArtifacts: latestArtifacts,
      nextRecommendedAction: project.nextAction,
    };
    return { result, requestedAction: `get context pack for project ${project.name}`, projectId };
  },
});

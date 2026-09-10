/**
 * Attention Queue (CTOS-005A Part 6).
 *
 * Derives actionable operator items from OSData.
 * Pure function — no persistent table; computed on demand.
 * Items are ordered by urgency: CRITICAL > HIGH > MEDIUM > LOW.
 */
import type { OSData } from "@/data/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AttentionUrgency = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type AttentionKind =
  | "needs_a_hand"
  | "pending_approval"
  | "gate_decision"
  | "launch_hold"
  | "build_pack_conflict"
  | "client_feedback"
  | "revision_escalation"
  | "qa_critical"
  | "qa_major"
  | "visual_defect"
  | "design_gate_blocked";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  urgency: AttentionUrgency;
  projectId: string | null;
  title: string;
  detail: string;
  /** The entity that must act (e.g. "operator", "project lead", "client") */
  requiredActor: string;
  /** Deep link hint for the dashboard */
  linkHint: string;
  /** Source entity IDs that generated this item */
  sourceIds: string[];
}

const URGENCY_ORDER: Record<AttentionUrgency, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** Derive the full attention queue for the operator dashboard. */
export function deriveAttentionQueue(data: OSData): AttentionItem[] {
  const items: AttentionItem[] = [];

  // 1. NEEDS_A_HAND jobs — highest urgency: execution is blocked
  for (const job of data.agentJobs.filter((j) => j.status === "NEEDS_A_HAND")) {
    items.push({
      id: `nah-${job.id}`,
      kind: "needs_a_hand",
      urgency: "CRITICAL",
      projectId: job.projectId,
      title: `Job needs attention: ${job.taskType ?? job.id}`,
      detail: job.error ? `Reason: ${job.error}` : "All providers exhausted. Use Mode B or Mode C to continue.",
      requiredActor: "operator",
      linkHint: `/projects/${job.projectId}/jobs/${job.id}`,
      sourceIds: [job.id],
    });
  }

  // 2. Pending approvals — HIGH urgency: workflow blocked
  for (const approval of data.jobApprovals.filter((a) => a.status === "PENDING")) {
    const job = data.agentJobs.find((j) => j.id === approval.jobId);
    items.push({
      id: `appr-${approval.id}`,
      kind: "pending_approval",
      urgency: "HIGH",
      projectId: approval.projectId,
      title: `Artifact awaiting approval: ${job?.taskType ?? approval.jobId}`,
      detail: `Permission level: ${approval.permissionLevel}. Must be reviewed before job can complete.`,
      requiredActor: approval.approvedByRole ?? "operator",
      linkHint: `/projects/${approval.projectId}/approvals/${approval.id}`,
      sourceIds: [approval.id],
    });
  }

  // 3. Gate definitions that require human approval — HIGH urgency
  // GateDefinition is a template; surface them when any project has no consumed gate for them
  for (const gate of data.gates.filter((g) => g.requiresHumanApproval)) {
    items.push({
      id: `gate-${gate.id}`,
      kind: "gate_decision",
      urgency: "HIGH",
      projectId: null,
      title: `Gate requires human approval: ${gate.label}`,
      detail: gate.description,
      requiredActor: "operator",
      linkHint: `/gates/${gate.id}`,
      sourceIds: [gate.id],
    });
  }

  // 4. Launch holds — HIGH urgency
  for (const hold of data.launchHolds.filter((h) => !h.resolved)) {
    items.push({
      id: `hold-${hold.id}`,
      kind: "launch_hold",
      urgency: "HIGH",
      projectId: hold.projectId,
      title: `Launch hold: ${hold.title}`,
      detail: hold.detail ?? "This hold must be resolved before launch.",
      requiredActor: "operator",
      linkHint: `/projects/${hold.projectId}/holds/${hold.id}`,
      sourceIds: [hold.id],
    });
  }

  // 5. Build-pack conflicts — MEDIUM urgency (blocks Agent 05 but not current phase)
  for (const bp of data.buildPacks.filter((b) => b.status === "CONFLICT")) {
    items.push({
      id: `bpc-${bp.id}`,
      kind: "build_pack_conflict",
      urgency: "MEDIUM",
      projectId: bp.projectId,
      title: `Build pack conflict (${bp.conflicts.length} issue${bp.conflicts.length !== 1 ? "s" : ""})`,
      detail: bp.conflicts.map((c) => c.detail).join("; "),
      requiredActor: "operator",
      linkHint: `/projects/${bp.projectId}/build-packs/${bp.id}`,
      sourceIds: [bp.id],
    });
  }

  // 6. Client feedback / unconfirmed change requests — MEDIUM urgency
  const unconfirmedCRs = data.changeRequests.filter((cr) => cr.confirmedAt === null);
  if (unconfirmedCRs.length > 0) {
    const byProject = groupBy(unconfirmedCRs, (cr) => cr.projectId);
    for (const [projectId, crs] of Object.entries(byProject)) {
      items.push({
        id: `cr-${projectId}`,
        kind: "client_feedback",
        urgency: "MEDIUM",
        projectId,
        title: `${crs.length} unconfirmed change request${crs.length !== 1 ? "s" : ""} need classification`,
        detail: "Project lead must classify each change request as in-scope, out-of-scope, or needs decision.",
        requiredActor: "project lead",
        linkHint: `/projects/${projectId}/revisions`,
        sourceIds: crs.map((cr) => cr.id),
      });
    }
  }

  // 7. Revision escalation — open rounds older than 3 rounds without completion
  const openRounds = data.revisionRounds.filter((r) => r.completedAt === null && r.roundNumber >= 3);
  for (const round of openRounds) {
    items.push({
      id: `rev-${round.id}`,
      kind: "revision_escalation",
      urgency: "MEDIUM",
      projectId: round.projectId,
      title: `Revision escalation: round ${round.roundNumber} still open`,
      detail: "Multiple revision rounds without completion may indicate scope creep. Escalate to project lead.",
      requiredActor: "project lead",
      linkHint: `/projects/${round.projectId}/revisions`,
      sourceIds: [round.id],
    });
  }

  // 8. Unresolved CRITICAL (P0) QA items — HIGH urgency; block progression
  const criticalQA = data.qaItems.filter((q) => q.severity === "P0" && q.status !== "VERIFIED" && q.status !== "WONT_FIX");
  for (const qa of criticalQA) {
    items.push({
      id: `qac-${qa.id}`,
      kind: "qa_critical",
      urgency: "HIGH",
      projectId: qa.projectId,
      title: `CRITICAL QA defect: ${qa.title}`,
      detail: qa.description,
      requiredActor: "operator",
      linkHint: `/projects/${qa.projectId}/qa/${qa.id}`,
      sourceIds: [qa.id],
    });
  }

  // 9. Unresolved MAJOR (P1) QA items — MEDIUM urgency; block progression
  const majorQA = data.qaItems.filter((q) => q.severity === "P1" && q.status !== "VERIFIED" && q.status !== "WONT_FIX");
  for (const qa of majorQA) {
    items.push({
      id: `qam-${qa.id}`,
      kind: "qa_major",
      urgency: "MEDIUM",
      projectId: qa.projectId,
      title: `MAJOR QA defect: ${qa.title}`,
      detail: qa.description,
      requiredActor: "operator",
      linkHint: `/projects/${qa.projectId}/qa/${qa.id}`,
      sourceIds: [qa.id],
    });
  }

  // 10. Unresolved MINOR (P2) and COSMETIC (P3) QA items — LOW urgency; visible but non-blocking
  const minorQA = data.qaItems.filter((q) => (q.severity === "P2" || q.severity === "P3") && q.status !== "VERIFIED" && q.status !== "WONT_FIX");
  for (const qa of minorQA) {
    const label = qa.severity === "P2" ? "MINOR" : "COSMETIC";
    items.push({
      id: `qamin-${qa.id}`,
      kind: "qa_major" as AttentionKind,
      urgency: "LOW",
      projectId: qa.projectId,
      title: `${label} QA item: ${qa.title}`,
      detail: qa.description,
      requiredActor: "operator",
      linkHint: `/projects/${qa.projectId}/qa/${qa.id}`,
      sourceIds: [qa.id],
    });
  }

  // 11. CTOS-005B: Visual defects (Part 27) — P0/P1 at HIGH, P2/P3 at LOW
  const criticalVisualDefects = data.visualDefects.filter((d) => (d.severity === "P0" || d.severity === "P1") && d.status !== "VERIFIED" && d.status !== "WONT_FIX");
  for (const d of criticalVisualDefects) {
    const label = d.severity === "P0" ? "CRITICAL" : "MAJOR";
    items.push({
      id: `vdef-${d.id}`,
      kind: "visual_defect",
      urgency: d.severity === "P0" ? "HIGH" : "MEDIUM",
      projectId: d.projectId,
      title: `${label} visual defect: ${d.category} — ${d.description.slice(0, 80)}`,
      detail: `Category: ${d.category}. ${d.evidence.length > 0 ? `Evidence: ${d.evidence[0]}` : "No evidence attached."}`,
      requiredActor: "operator",
      linkHint: `/projects/${d.projectId}/visual-defects/${d.id}`,
      sourceIds: [d.id],
    });
  }

  const minorVisualDefects = data.visualDefects.filter((d) => (d.severity === "P2" || d.severity === "P3") && d.status !== "VERIFIED" && d.status !== "WONT_FIX");
  for (const d of minorVisualDefects) {
    const label = d.severity === "P2" ? "MINOR" : "COSMETIC";
    items.push({
      id: `vdefm-${d.id}`,
      kind: "visual_defect",
      urgency: "LOW",
      projectId: d.projectId,
      title: `${label} visual defect: ${d.category}`,
      detail: d.description.slice(0, 120),
      requiredActor: "operator",
      linkHint: `/projects/${d.projectId}/visual-defects/${d.id}`,
      sourceIds: [d.id],
    });
  }

  // Sort by urgency then by kind for stable ordering
  return items.sort((a, b) => {
    const u = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (u !== 0) return u;
    return a.kind.localeCompare(b.kind);
  });
}

/** Derive attention items for a specific project only. */
export function projectAttentionQueue(data: OSData, projectId: string): AttentionItem[] {
  return deriveAttentionQueue(data).filter((i) => i.projectId === projectId || i.projectId === null);
}

/** True when there are no attention items for a project (all gates clear). */
export function projectClear(data: OSData, projectId: string): boolean {
  return projectAttentionQueue(data, projectId).length === 0;
}

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (result[k] ??= []).push(item);
  }
  return result;
}

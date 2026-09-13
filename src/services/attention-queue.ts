/**
 * Attention Queue (CTOS-005A Part 6).
 *
 * Derives actionable operator items from OSData.
 * Pure function — no persistent table; computed on demand.
 * Items are ordered by urgency: CRITICAL > HIGH > MEDIUM > LOW.
 */
import type { OSData } from "@/data/types";
import { isAuditJob } from "./website-audit";

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
  | "design_gate_blocked"
  // CTOS-006: WordPress Write Engine
  | "wp_change_plan_approval"
  | "wp_write_conflict"
  | "wp_write_failed"
  | "wp_site_offline"
  // CTOS-007: Website Audit Engine
  | "audit_failed"
  | "audit_complete";

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

  // 1. NEEDS_A_HAND jobs — highest urgency: execution is blocked. Audit jobs surface via their request (16).
  for (const job of data.agentJobs.filter((j) => j.status === "NEEDS_A_HAND" && !isAuditJob(data, j))) {
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

  // 12. CTOS-006: WP change plans awaiting approval (READY status = approved by engine, awaiting human for AMBER)
  const pendingWpPlans = data.websiteChangePlans.filter((p) => p.status === "READY");
  for (const plan of pendingWpPlans) {
    items.push({
      id: `wcp-approval-${plan.id}`,
      kind: "wp_change_plan_approval",
      urgency: "HIGH",
      projectId: plan.projectId,
      title: `Website change plan requires approval`,
      detail: `Plan ${plan.id}: ${plan.actions.length} action(s) for page "${plan.targetPageTitle ?? plan.targetPageId}". Tier: ${plan.overallPermissionTier}.`,
      requiredActor: "operator",
      linkHint: `/projects/${plan.projectId}/write-engine/${plan.id}`,
      sourceIds: [plan.id],
    });
  }

  // 13. CTOS-006: WP write conflicts — precondition failures requiring human resolution
  const conflictedResults = data.websiteWriteResults.filter((r) => r.status === "CONFLICT_DETECTED");
  for (const result of conflictedResults) {
    items.push({
      id: `wwr-conflict-${result.id}`,
      kind: "wp_write_conflict",
      urgency: "HIGH",
      projectId: result.projectId,
      title: `Website write conflict: human edit detected`,
      detail: `Write result ${result.id}: a human edit was detected on the target page during execution. Review and re-approve the change plan.`,
      requiredActor: "operator",
      linkHint: `/projects/${result.projectId}/write-engine/results/${result.id}`,
      sourceIds: [result.id],
    });
  }

  // 14. CTOS-006: WP write failures (not conflicts)
  const failedResults = data.websiteWriteResults.filter(
    (r) =>
      r.status === "FAILED_WRITE" ||
      r.status === "FAILED_READBACK" ||
      r.status === "FAILED_CONNECTION" ||
      r.status === "FAILED_PERMISSION" ||
      r.status === "FAILED_VALIDATION" ||
      r.status === "FAILED_ROLLBACK" ||
      r.status === "NEEDS_A_HAND",
  );
  for (const result of failedResults) {
    items.push({
      id: `wwr-failed-${result.id}`,
      kind: "wp_write_failed",
      urgency: result.status === "NEEDS_A_HAND" ? "HIGH" : "MEDIUM",
      projectId: result.projectId,
      title: `Website write failed: ${result.status}`,
      detail: `Write result ${result.id}. ${result.errors.length} error(s) recorded.`,
      requiredActor: "operator",
      linkHint: `/projects/${result.projectId}/write-engine/results/${result.id}`,
      sourceIds: [result.id],
    });
  }

  // 15. CTOS-006: WP site offline (OFFLINE or AUTH_FAILED connections tied to active projects)
  const offlineConnections = data.wpSiteConnections.filter(
    (c) => c.connectionStatus === "OFFLINE" || c.connectionStatus === "AUTH_FAILED",
  );
  for (const conn of offlineConnections) {
    const isActive = data.projects.some((p) => p.id === conn.projectId);
    if (!isActive) continue;
    items.push({
      id: `wsc-offline-${conn.id}`,
      kind: "wp_site_offline",
      urgency: conn.connectionStatus === "AUTH_FAILED" ? "HIGH" : "MEDIUM",
      projectId: conn.projectId,
      title: `WordPress site ${conn.connectionStatus === "AUTH_FAILED" ? "auth failed" : "offline"}: ${conn.siteUrl}`,
      detail: `Site connection ${conn.id} is ${conn.connectionStatus}. Write actions are blocked until connection is restored.`,
      requiredActor: "operator",
      linkHint: `/projects/${conn.projectId}/site-connection/${conn.id}`,
      sourceIds: [conn.id],
    });
  }

  // 16. CTOS-007A: audits that did not fully complete (FAILED / NEEDS_A_HAND / PARTIAL) until reviewed
  for (const req of (data.websiteAuditRequests ?? []).filter((r) => r.reviewedAt === null && (r.status === "FAILED" || r.status === "NEEDS_A_HAND" || r.status === "PARTIAL"))) {
    const failedJobs = data.agentJobs.filter((j) => req.auditJobIds.includes(j.id) && j.status !== "COMPLETED");
    items.push({
      id: `audit-failed-${req.id}`,
      kind: "audit_failed",
      urgency: req.status === "PARTIAL" ? "MEDIUM" : "HIGH",
      projectId: req.projectId,
      title: `Website audit ${req.status.toLowerCase().replace(/_/g, " ")}: ${req.targetUrl}`,
      detail: req.failureReason ?? (failedJobs.length ? `${failedJobs.length} specialist job(s) did not complete: ${failedJobs.map((j) => `${j.agentId} ${j.status}`).join(", ")}.` : "Audit did not fully complete — see request details."),
      requiredActor: "operator",
      linkHint: req.projectId ? `/projects/${req.projectId}?tab=audit` : `/audit/${req.id}`,
      sourceIds: [req.id, ...failedJobs.map((j) => j.id)],
    });
  }

  // 17. CTOS-007A: completed audits awaiting operator review
  for (const req of (data.websiteAuditRequests ?? []).filter((r) => r.status === "COMPLETE" && r.resultArtifactId && r.reviewedAt === null)) {
    items.push({
      id: `audit-complete-${req.id}`,
      kind: "audit_complete",
      urgency: "LOW",
      projectId: req.projectId,
      title: `Audit complete: ${req.targetUrl}`,
      detail: "Website audit results are ready for review.",
      requiredActor: "operator",
      linkHint: req.projectId ? `/projects/${req.projectId}?tab=audit` : `/audit/${req.id}`,
      sourceIds: [req.id],
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

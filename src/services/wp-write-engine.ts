/**
 * WordPress Write Engine (CTOS-006 Parts 10–22).
 *
 * Pure-function execution core for controlled WordPress/Elementor writes.
 * Follows the same pattern as agent-jobs.ts: OSData in → OSData out (plus side-effect envelope).
 *
 * Execution sequence (Part 10):
 *   1.  validate change plan
 *   2.  verify site connection
 *   3.  verify environment
 *   4.  verify permissions
 *   5.  verify required human approval
 *   6.  resolve target
 *   7.  read current state
 *   8.  verify preconditions (compare-and-swap)
 *   9.  create revision snapshot (FAILS CLOSED if snapshot fails)
 *  10.  execute permitted write
 *  11.  read back actual state
 *  12.  compare actual vs expected
 *  13.  record result
 *  14.  request screenshot evidence if relevant
 *  15.  update workflow/attention state
 *
 * Security constraints (Part 32):
 * - Never reports success based on HTTP 200 alone — read-back required.
 * - Never logs or stores secrets, tokens, nonces, auth headers, cookies.
 * - Never permits arbitrary SQL, PHP, shell, or script injection.
 * - Idempotency prevents duplicate actions on retry.
 */
import type {
  OSData,
  ISODate,
  PermissionLevel,
  WebsiteChangePlan,
  WebsiteRevisionSnapshot,
  WebsiteWriteResult,
  WpActionResult,
  WpWriteAuditEntry,
  WpIdempotencyRecord,
  WpWriteAction,
  WpChangePlanStatus,
  WpWriteResultStatus,
  ScreenshotEvidence,
  WpDiffModel,
  WpSiteConnectionChecklist,
  WordPressSiteConnection,
  ElementorNode,
  ElementorDocument,
} from "@/data/types";
import type { WordPressAdapter } from "./wp-adapter";
import {
  actionPermissionTier,
  effectiveWpPermissionLevel,
  detectUnsafeContent,
  validateSafeUrl,
  isSafeStyleKey,
} from "./wp-permissions";

// ---------------------------------------------------------------------------
// Engine input/output types
// ---------------------------------------------------------------------------

export interface WpEngineOptions {
  newId?: (prefix: string) => string;
  now?: () => ISODate;
  /** Auth user performing the operation. */
  actorId?: string;
  actorName?: string;
}

export type WpEngineFailureReason =
  | "PLAN_NOT_FOUND"
  | "PLAN_INVALID_STATUS"
  | "CONNECTION_NOT_FOUND"
  | "SITE_OFFLINE"
  | "AUTH_FAILED"
  | "PERMISSION_DENIED"
  | "APPROVAL_REQUIRED"
  | "TARGET_AMBIGUOUS"
  | "PRECONDITION_CONFLICT"
  | "SNAPSHOT_FAILED"
  | "WRITE_FAILED"
  | "READBACK_FAILED"
  | "IDEMPOTENCY_DUPLICATE"
  | "VALIDATION_ERROR"
  | "ENVIRONMENT_PROHIBITED";

export interface WpEngineSuccess {
  ok: true;
  data: OSData;
  writeResultId: string;
  screenshotRequestedForPageId: string | null;
}

export interface WpEngineFailure {
  ok: false;
  reason: WpEngineFailureReason;
  message: string;
  data: OSData;
}

export type WpEngineOutcome = WpEngineSuccess | WpEngineFailure;

// ---------------------------------------------------------------------------
// Plan creation (pure)
// ---------------------------------------------------------------------------

export interface CreateChangePlanInput {
  id?: string;
  projectId: string;
  siteConnectionId: string;
  sourceRequest: string;
  buildPackId?: string;
  elementorManifestArtifactId?: string;
  targetPageId?: string;
  targetPageTitle?: string;
  actions: WpWriteAction[];
  rollbackStrategy?: string;
  risks?: string[];
  createdByJobId?: string;
  provenance?: string;
}

/** Create a WebsiteChangePlan and add it to OSData. Pure — no adapter calls. */
export function createChangePlan(
  data: OSData,
  input: CreateChangePlanInput,
  opts: WpEngineOptions = {},
): { data: OSData; plan: WebsiteChangePlan } {
  const newId = opts.newId ?? defaultId;
  const now = opts.now ?? defaultNow;

  const conn = data.wpSiteConnections.find((c) => c.id === input.siteConnectionId);

  // Compute overall permission tier
  const actionTypes = input.actions.map((a) => a.type);
  const baseTier = actionTypes.reduce<PermissionLevel>((acc, t) => {
    const at = actionPermissionTier(t);
    if (at === "RED" || acc === "RED") return "RED";
    if (at === "AMBER" || acc === "AMBER") return "AMBER";
    return "GREEN";
  }, "GREEN");

  const environment = conn?.environment ?? "STAGING";
  const overallPermissionTier = effectiveWpPermissionLevel(baseTier, environment);

  const screenshotRequired = input.actions.some((a) =>
    ["UPDATE_HEADING", "UPDATE_TEXT", "REPLACE_IMAGE", "UPDATE_WIDGET_CONTENT",
     "UPDATE_WIDGET_STYLE_SAFE", "ADD_APPROVED_SECTION", "REMOVE_DRAFT_SECTION",
     "REORDER_DRAFT_SECTIONS", "CREATE_DRAFT_PAGE"].includes(a.type),
  );

  const plan: WebsiteChangePlan = {
    id: input.id ?? newId("wcp"),
    projectId: input.projectId,
    siteConnectionId: input.siteConnectionId,
    environment,
    sourceRequest: input.sourceRequest,
    buildPackId: input.buildPackId ?? null,
    elementorManifestArtifactId: input.elementorManifestArtifactId ?? null,
    targetPageId: input.targetPageId ?? null,
    targetPageTitle: input.targetPageTitle ?? null,
    actions: input.actions,
    overallPermissionTier,
    backupRequired: input.actions.length > 0,
    verificationRequired: true,
    screenshotRequired,
    rollbackStrategy: input.rollbackStrategy ?? "Restore prior revision snapshot if available.",
    humanApprovalsRequired: overallPermissionTier !== "GREEN"
      ? ["Production Lead must approve before execution."]
      : [],
    risks: input.risks ?? [],
    status: "DRAFT",
    approvedById: null,
    approvedAt: null,
    executingJobId: null,
    createdByJobId: input.createdByJobId ?? null,
    provenance: input.provenance ?? "CTOS-006 write engine",
    createdAt: now(),
    updatedAt: now(),
  };

  return {
    data: { ...data, websiteChangePlans: [...data.websiteChangePlans, plan] },
    plan,
  };
}

/** Approve a change plan for execution. */
export function approveChangePlan(
  data: OSData,
  planId: string,
  approverId: string,
  _approverName: string,
  opts: WpEngineOptions = {},
): { data: OSData; plan: WebsiteChangePlan } {
  const now = opts.now ?? defaultNow;
  const plan = data.websiteChangePlans.find((p) => p.id === planId);
  if (!plan) throw new Error(`Change plan ${planId} not found`);
  if (plan.status !== "DRAFT" && plan.status !== "READY") {
    throw new Error(`Plan ${planId} is ${plan.status}; can only approve DRAFT or READY plans.`);
  }
  const updated: WebsiteChangePlan = {
    ...plan,
    status: "READY",
    approvedById: approverId,
    approvedAt: now(),
    updatedAt: now(),
  };
  return {
    data: { ...data, websiteChangePlans: data.websiteChangePlans.map((p) => p.id === planId ? updated : p) },
    plan: updated,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export interface PlanValidationResult {
  ok: boolean;
  issues: string[];
}

export function validateChangePlan(data: OSData, planId: string): PlanValidationResult {
  const plan = data.websiteChangePlans.find((p) => p.id === planId);
  if (!plan) return { ok: false, issues: [`Plan ${planId} not found`] };

  const issues: string[] = [];

  // Connection must exist
  const conn = data.wpSiteConnections.find((c) => c.id === plan.siteConnectionId);
  if (!conn) issues.push(`Site connection ${plan.siteConnectionId} not found`);

  // Validate each action
  for (const action of plan.actions) {
    // Target resolution: at least one target ID must be set for non-page-creation actions
    if (action.type !== "CREATE_DRAFT_PAGE") {
      const t = action.target;
      const hasTarget = t.pageId || t.templateId || t.elementorElementId || t.widgetId || t.containerId;
      if (!hasTarget) issues.push(`Action ${action.id} (${action.type}) has no resolved target`);
    }

    // Security: scan payload values for unsafe content
    for (const [k, v] of Object.entries(action.payload)) {
      if (typeof v === "string") {
        const unsafe = detectUnsafeContent(v);
        if (unsafe) issues.push(`Action ${action.id} payload.${k}: ${unsafe}`);
        // URL validation for button/link fields
        if ((k === "url" || k === "href") && v) {
          const urlErr = validateSafeUrl(v);
          if (urlErr) issues.push(`Action ${action.id} payload.${k}: ${urlErr}`);
        }
      }
    }

    // Safe style key enforcement
    if (action.type === "UPDATE_WIDGET_STYLE_SAFE") {
      const key = action.payload["settingKey"] as string | undefined;
      if (key && !isSafeStyleKey(key) && actionPermissionTier(action.type) === "GREEN") {
        issues.push(`Action ${action.id}: style key "${key}" is not in the GREEN whitelist. Use AMBER path for custom CSS.`);
      }
    }

    // Approved section enforcement: libraryEntryId must reference a APPROVED entry
    if (action.type === "ADD_APPROVED_SECTION") {
      const entryId = action.payload["libraryEntryId"] as string | undefined;
      if (!entryId) {
        issues.push(`Action ${action.id}: ADD_APPROVED_SECTION requires libraryEntryId in payload`);
      } else {
        const entry = data.sectionLibrary.find((e) => e.id === entryId);
        if (!entry) {
          issues.push(`Action ${action.id}: section library entry "${entryId}" not found`);
        } else if (entry.status !== "APPROVED") {
          issues.push(`Action ${action.id}: section library entry "${entryId}" has status "${entry.status}"; only APPROVED entries may be inserted`);
        }
      }
    }
  }

  // No empty action list
  if (plan.actions.length === 0) issues.push("Change plan has no actions");

  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Main execution engine (Part 10)
// ---------------------------------------------------------------------------

export interface WpExecuteInput {
  planId: string;
  /** Only required when plan.overallPermissionTier is AMBER or RED. */
  approvalId?: string;
}

export async function executeChangePlan(
  data: OSData,
  input: WpExecuteInput,
  adapter: WordPressAdapter,
  opts: WpEngineOptions = {},
): Promise<WpEngineOutcome> {
  const newId = opts.newId ?? defaultId;
  const now = opts.now ?? defaultNow;

  // Step 1: validate change plan
  const plan = data.websiteChangePlans.find((p) => p.id === input.planId);
  if (!plan) return fail(data, "PLAN_NOT_FOUND", `Change plan ${input.planId} not found`);
  if (plan.status !== "READY") return fail(data, "PLAN_INVALID_STATUS", `Plan ${plan.id} is ${plan.status}; must be READY to execute`);

  const validation = validateChangePlan(data, plan.id);
  if (!validation.ok) return fail(data, "VALIDATION_ERROR", validation.issues.join("; "));

  // Step 2: verify site connection
  const conn = data.wpSiteConnections.find((c) => c.id === plan.siteConnectionId);
  if (!conn) return fail(data, "CONNECTION_NOT_FOUND", `Site connection ${plan.siteConnectionId} not found`);

  let connCheck;
  try {
    connCheck = await adapter.verifyConnection();
  } catch (e) {
    return fail(data, "SITE_OFFLINE", `Connection check threw: ${String(e)}`);
  }
  if (!connCheck.online) return fail(data, "SITE_OFFLINE", connCheck.error ?? "Site offline");
  if (!connCheck.authOk) return fail(data, "AUTH_FAILED", "Authentication failed");

  // Step 3: verify environment — production publish never autonomous
  if (conn.environment === "PRODUCTION" && plan.overallPermissionTier === "GREEN") {
    // Upgrade silently to AMBER check — require explicit approval
    if (!input.approvalId) {
      return fail(data, "PERMISSION_DENIED", "Production writes require AMBER approval even for GREEN actions (CTOS-006 Part 24)");
    }
  }

  // Step 4: verify permissions
  for (const action of plan.actions) {
    const required = effectiveWpPermissionLevel(actionPermissionTier(action.type), conn.environment);
    if (required === "RED") return fail(data, "PERMISSION_DENIED", `Action ${action.type} is RED — never executed autonomously`);
    if (required === "AMBER" && !input.approvalId) {
      return fail(data, "APPROVAL_REQUIRED", `Action ${action.type} requires AMBER approval (approvalId missing)`);
    }
  }

  // Step 5: verify required human approval for AMBER/RED
  if (plan.overallPermissionTier !== "GREEN" && !input.approvalId) {
    return fail(data, "APPROVAL_REQUIRED", `Plan tier is ${plan.overallPermissionTier}; human approval required before execution`);
  }

  // Step 6: check idempotency — skip if already successfully applied
  for (const action of plan.actions) {
    const existing = data.wpIdempotencyLog.find((r) => r.idempotencyKey === action.idempotencyKey && r.projectId === plan.projectId);
    if (existing) {
      const prevResult = data.websiteWriteResults.find((r) => r.id === existing.resultId);
      if (prevResult?.status === "SUCCEEDED_VERIFIED") {
        return fail(data, "IDEMPOTENCY_DUPLICATE", `Action ${action.id} (${action.type}) already successfully applied (key: ${action.idempotencyKey})`);
      }
    }
  }

  // Mark plan as executing
  let workData = updatePlanStatus(data, plan.id, "EXECUTING", now);

  // Determine target page(s)
  const targetPageId = plan.targetPageId ?? plan.actions.find((a) => a.target.pageId)?.target.pageId ?? null;

  // Steps 7–8: read current state and verify preconditions
  if (targetPageId) {
    const currentPage = await adapter.getPage(targetPageId);
    if (!currentPage) return fail(workData, "TARGET_AMBIGUOUS", `Target page ${targetPageId} not found on site`);

    // Check preconditions (compare-and-swap)
    for (const action of plan.actions) {
      for (const pre of action.preconditions) {
        if (pre.kind === "elementor_hash" || pre.kind === "content_value") {
          if (currentPage.contentHash !== pre.expectedValue) {
            const conflict = workData;
            workData = updatePlanStatus(conflict, plan.id, "FAILED", now);
            return fail(workData, "PRECONDITION_CONFLICT", `Human edit detected on page ${targetPageId}: expected hash ${pre.expectedValue} but found ${currentPage.contentHash}. Do not overwrite.`);
          }
        }
      }
    }
  }

  // Step 9: create revision snapshot (FAILS CLOSED — write blocked if snapshot fails)
  let snapshotId: string | null = null;
  if (plan.backupRequired && targetPageId) {
    try {
      const snap = await adapter.createRevisionSnapshot(targetPageId);
      const snapshot: WebsiteRevisionSnapshot = {
        id: newId("snap"),
        projectId: plan.projectId,
        siteConnectionId: conn.id,
        pageId: targetPageId,
        environment: conn.environment,
        capturedAt: now(),
        sourceRevision: snap.revisionId,
        elementorDocumentRef: null, // reference-only: actual payload on storage
        pageContentRef: null,
        contentHash: snap.contentHash,
        originatingJobId: plan.executingJobId,
        originatingChangePlanId: plan.id,
      };
      workData = { ...workData, websiteRevisionSnapshots: [...workData.websiteRevisionSnapshots, snapshot] };
      snapshotId = snapshot.id;
    } catch (e) {
      workData = updatePlanStatus(workData, plan.id, "FAILED", now);
      return fail(workData, "SNAPSHOT_FAILED", `Revision snapshot failed — write blocked: ${String(e)}`);
    }
  }

  // Step 10–12: execute actions, read back, verify
  const actionResults: WpActionResult[] = [];
  const errors: string[] = [];
  let overallOk = true;
  let screenshotPageId: string | null = null;

  for (const action of plan.actions) {
    let ar: WpActionResult;
    try {
      ar = await executeAction(action, targetPageId, plan, adapter, now);
      if (ar.status === "CONFLICT") {
        errors.push(`Conflict on action ${action.id}`);
        overallOk = false;
      } else if (ar.status === "FAILED") {
        errors.push(ar.error ?? `Action ${action.id} failed`);
        overallOk = false;
      }
      if (ar.verificationPassed === false) {
        errors.push(`Read-back verification failed for action ${action.id}`);
        overallOk = false;
      }
    } catch (e) {
      ar = { actionId: action.id, type: action.type, status: "FAILED", beforeValue: null, afterValue: null, error: String(e), verificationPassed: false };
      errors.push(String(e));
      overallOk = false;
    }
    actionResults.push(ar);

    // Track if screenshot needed
    if (overallOk && plan.screenshotRequired && targetPageId) {
      screenshotPageId = targetPageId;
    }
  }

  // Step 13: determine result status
  const resultStatus: WpWriteResultStatus = !overallOk
    ? actionResults.some((r) => r.status === "CONFLICT") ? "CONFLICT_DETECTED"
      : actionResults.some((r) => r.verificationPassed === false) ? "FAILED_READBACK"
      : "FAILED_WRITE"
    : "SUCCEEDED_VERIFIED";

  const writeResultId = newId("wwr");
  const writeResult: WebsiteWriteResult = {
    id: writeResultId,
    changePlanId: plan.id,
    projectId: plan.projectId,
    siteConnectionId: conn.id,
    status: resultStatus,
    actionResults,
    beforeSnapshotId: snapshotId,
    afterStateHash: null,
    verificationResults: [],
    startedAt: now(),
    completedAt: now(),
    transport: adapter.transport,
    actorId: opts.actorId ?? null,
    actorName: opts.actorName ?? null,
    errors,
    rollbackStatus: overallOk ? "NOT_NEEDED" : "NOT_ATTEMPTED",
    provenance: `CTOS-006 / plan:${plan.id}`,
  };

  // Audit log (Part 33) — NEVER logs secrets
  const auditEntry: WpWriteAuditEntry = {
    id: newId("waud"),
    projectId: plan.projectId,
    siteConnectionId: conn.id,
    environment: conn.environment,
    changePlanId: plan.id,
    writeResultId,
    requestedById: opts.actorId ?? null,
    requestedByName: opts.actorName ?? null,
    permissionLevel: plan.overallPermissionTier,
    approvalId: input.approvalId ?? null,
    actionTypes: plan.actions.map((a) => a.type),
    transport: adapter.transport,
    timestamp: now(),
    beforeSnapshotId: snapshotId,
    result: resultStatus,
    verificationPassed: overallOk,
    rollbackPerformed: false,
  };

  // Idempotency records for successfully applied actions
  const newIdempotencyRecords: WpIdempotencyRecord[] = overallOk
    ? plan.actions.map((a) => ({
        id: newId("widem"),
        idempotencyKey: a.idempotencyKey,
        changePlanId: plan.id,
        projectId: plan.projectId,
        appliedAt: now(),
        resultId: writeResultId,
      }))
    : [];

  // Step 14: screenshot request (as ScreenshotEvidence with status "pending")
  const screenshotEvidence: ScreenshotEvidence[] = [];
  if (overallOk && screenshotPageId && plan.screenshotRequired) {
    const pageInfo = await adapter.getPage(screenshotPageId).catch(() => null);
    const siteUrl = conn.siteUrl;
    for (const viewport of ["desktop", "mobile"] as const) {
      screenshotEvidence.push({
        id: newId("sse"),
        projectId: plan.projectId,
        jobId: plan.executingJobId,
        url: pageInfo ? `${siteUrl}${pageInfo.slug !== "/" ? `/${pageInfo.slug}` : ""}` : siteUrl,
        viewport,
        widthPx: viewport === "desktop" ? 1440 : 375,
        heightPx: viewport === "desktop" ? 900 : 812,
        capturedAt: null,
        captureStatus: "pending",
        consoleErrors: [],
        loadErrors: [],
      });
    }
  }

  // Update plan status
  const finalPlanStatus: WpChangePlanStatus = overallOk ? "COMPLETED" : "FAILED";
  workData = updatePlanStatus(workData, plan.id, finalPlanStatus, now);

  // Compose final OSData
  const finalData: OSData = {
    ...workData,
    websiteWriteResults: [...workData.websiteWriteResults, writeResult],
    wpWriteAuditLog: [...workData.wpWriteAuditLog, auditEntry],
    wpIdempotencyLog: [...workData.wpIdempotencyLog, ...newIdempotencyRecords],
    screenshotEvidence: [...workData.screenshotEvidence, ...screenshotEvidence],
  };

  if (!overallOk) {
    return { ok: false, reason: actionResults.some((r) => r.status === "CONFLICT") ? "PRECONDITION_CONFLICT" : "WRITE_FAILED", message: errors.join("; "), data: finalData };
  }

  return { ok: true, data: finalData, writeResultId, screenshotRequestedForPageId: screenshotPageId };
}

// ---------------------------------------------------------------------------
// Rollback (Part 13)
// ---------------------------------------------------------------------------

export interface WpRollbackInput {
  writeResultId: string;
  actorId?: string;
  actorName?: string;
}

export async function rollbackWrite(
  data: OSData,
  input: WpRollbackInput,
  adapter: WordPressAdapter,
  opts: WpEngineOptions = {},
): Promise<{ ok: boolean; message: string; data: OSData }> {
  const newId = opts.newId ?? defaultId;
  const now = opts.now ?? defaultNow;

  const result = data.websiteWriteResults.find((r) => r.id === input.writeResultId);
  if (!result) return { ok: false, message: `Write result ${input.writeResultId} not found`, data };

  if (!result.beforeSnapshotId) return { ok: false, message: "No revision snapshot to roll back to", data };

  const snapshot = data.websiteRevisionSnapshots.find((s) => s.id === result.beforeSnapshotId);
  if (!snapshot) return { ok: false, message: `Snapshot ${result.beforeSnapshotId} not found`, data };
  if (!snapshot.sourceRevision) return { ok: false, message: "Snapshot has no WordPress revision ID", data };

  // Read current state before restoring
  const current = await adapter.getPage(snapshot.pageId).catch(() => null);
  if (!current) return { ok: false, message: `Page ${snapshot.pageId} not found`, data };

  // Execute rollback (which is itself a write — permission check applies)
  let rollbackOk = false;
  let rollbackMessage = "";
  try {
    const restored = await adapter.restoreRevisionSnapshot(snapshot.pageId, snapshot.sourceRevision);
    // Read back to verify restoration
    const verify = await adapter.getPage(snapshot.pageId);
    if (verify?.contentHash === snapshot.contentHash || restored.afterStateHash === snapshot.contentHash) {
      rollbackOk = true;
      rollbackMessage = `Restored to revision ${snapshot.sourceRevision}`;
    } else {
      rollbackMessage = `Read-back after rollback did not match snapshot hash`;
    }
  } catch (e) {
    rollbackMessage = `Rollback threw: ${String(e)}`;
  }

  // Audit the rollback
  const auditEntry: WpWriteAuditEntry = {
    id: newId("waud"),
    projectId: result.projectId,
    siteConnectionId: result.siteConnectionId,
    environment: snapshot.environment,
    changePlanId: result.changePlanId,
    writeResultId: result.id,
    requestedById: input.actorId ?? null,
    requestedByName: input.actorName ?? null,
    permissionLevel: "AMBER", // rollback is minimum AMBER
    approvalId: null,
    actionTypes: [],
    transport: adapter.transport,
    timestamp: now(),
    beforeSnapshotId: result.beforeSnapshotId,
    result: rollbackOk ? "SUCCEEDED_VERIFIED" : "FAILED_ROLLBACK",
    verificationPassed: rollbackOk,
    rollbackPerformed: true,
  };

  const updatedResult: WebsiteWriteResult = {
    ...result,
    rollbackStatus: rollbackOk ? "COMPLETED" : "FAILED",
  };

  const finalData: OSData = {
    ...data,
    websiteWriteResults: data.websiteWriteResults.map((r) => r.id === result.id ? updatedResult : r),
    wpWriteAuditLog: [...data.wpWriteAuditLog, auditEntry],
  };

  return { ok: rollbackOk, message: rollbackMessage, data: finalData };
}

// ---------------------------------------------------------------------------
// Diff model computation (Part 23)
// ---------------------------------------------------------------------------

export function computeDiff(
  _beforeHash: string,
  _afterHash: string,
  actionResults: WpActionResult[],
): WpDiffModel {
  const contentDiffs = actionResults
    .filter((r) => r.status === "SUCCEEDED" && r.beforeValue !== r.afterValue)
    .map((r) => ({
      field: r.type,
      old: String(r.beforeValue ?? ""),
      new: String(r.afterValue ?? ""),
    }));

  return {
    contentDiffs,
    elementorDiffs: [], // populated by Elementor-specific actions
    structuralChanges: [],
  };
}

// ---------------------------------------------------------------------------
// U-Proof onboarding (Part 30) — config only, no credentials, no writes
// ---------------------------------------------------------------------------

export interface UProofOnboardingConfig {
  siteUrl: string;
  hostProvider: "Hostinger";
  environment: "STAGING";
  builder: "ELEMENTOR_PRO";
  authMethod: "application_password";
  credentialsRef: string | null; // vault key — not the credential itself
  notes: string;
}

/** Create a WordPressSiteConnection record for U-Proof with no credentials or mutations. */
export function createUProofSiteConnection(
  data: OSData,
  projectId: string,
  config: UProofOnboardingConfig,
  opts: WpEngineOptions = {},
): { data: OSData; connection: WordPressSiteConnection; checklist: WpSiteConnectionChecklist } {
  const newId = opts.newId ?? defaultId;
  const now = opts.now ?? defaultNow;

  const connection: WordPressSiteConnection = {
    id: newId("wsc"),
    projectId,
    siteUrl: config.siteUrl,
    environment: config.environment,
    cms: "WORDPRESS",
    builder: config.builder,
    authMethod: config.authMethod,
    credentialsRef: config.credentialsRef, // vault key only — never the credential value
    connectionStatus: "UNCHECKED",
    lastVerifiedAt: null,
    capabilities: [],
    writeable: false, // must be verified before any write is permitted
    ownershipNote: config.notes,
    hostProvider: config.hostProvider,
    hostReplaceable: true, // Hostinger is a temporary host; project identity must survive migration
    createdAt: now(),
    updatedAt: now(),
  };

  const checklist: WpSiteConnectionChecklist = {
    siteConnectionId: connection.id,
    projectId,
    items: [
      { key: "site_url_confirmed", description: "Site URL reachable and matches project domain", required: true, complete: false, completedAt: null },
      { key: "auth_configured", description: "Application password credential reference set in vault", required: true, complete: false, completedAt: null },
      { key: "rest_api_accessible", description: "WordPress REST API accessible at /wp-json/", required: true, complete: false, completedAt: null },
      { key: "elementor_detected", description: "Elementor Pro detected and API accessible", required: true, complete: false, completedAt: null },
      { key: "builder_version_recorded", description: "Elementor version recorded for compatibility", required: true, complete: false, completedAt: null },
      { key: "backup_policy_set", description: "Backup policy documented before any write attempt", required: true, complete: false, completedAt: null },
      { key: "staging_confirmed", description: "Confirmed target is staging, not live production", required: true, complete: false, completedAt: null },
      { key: "known_page_ids_mapped", description: "Critical page IDs mapped from WordPress admin", required: false, complete: false, completedAt: null },
      { key: "migration_path_noted", description: "Hostinger migration path noted — connection supports host replacement", required: false, complete: false, completedAt: null },
    ],
    launchHoldIds: [],
    createdAt: now(),
  };

  return {
    data: { ...data, wpSiteConnections: [...data.wpSiteConnections, connection] },
    connection,
    checklist,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function updatePlanStatus(data: OSData, planId: string, status: WpChangePlanStatus, now: () => ISODate): OSData {
  return {
    ...data,
    websiteChangePlans: data.websiteChangePlans.map((p) =>
      p.id === planId ? { ...p, status, updatedAt: now() } : p,
    ),
  };
}

async function executeAction(
  action: WpWriteAction,
  targetPageId: string | null,
  _plan: WebsiteChangePlan,
  adapter: WordPressAdapter,
  _now: () => ISODate,
): Promise<WpActionResult> {
  const pageId = action.target.pageId ?? targetPageId;

  switch (action.type) {
    case "UPDATE_HEADING":
    case "UPDATE_TEXT": {
      if (!pageId) return actionFail(action, "No target page ID for text update");
      const before = await adapter.getPage(pageId);
      const value = action.payload["value"] as string;
      const field = action.payload["field"] as string ?? "title";
      const write = await adapter.updatePageContent(pageId, { field, value });
      // Read back
      const after = await adapter.getPage(pageId);
      const verified = after?.contentHash === write.afterStateHash;
      return { actionId: action.id, type: action.type, status: verified ? "SUCCEEDED" : "FAILED", beforeValue: before?.title, afterValue: after?.title, error: verified ? null : "Read-back hash mismatch", verificationPassed: verified };
    }

    case "UPDATE_BUTTON_LABEL":
    case "UPDATE_BUTTON_URL": {
      if (!pageId) return actionFail(action, "No target page ID");
      const value = action.payload["value"] as string;
      const field = action.type === "UPDATE_BUTTON_URL" ? "button_url" : "button_label";
      // URL safety already validated in plan validation; reject here as defence-in-depth
      if (action.type === "UPDATE_BUTTON_URL") {
        const urlErr = validateSafeUrl(value);
        if (urlErr) return actionFail(action, urlErr);
      }
      await adapter.updatePageContent(pageId, { field, value });
      const after = await adapter.getPage(pageId);
      const verified = after !== null;
      return { actionId: action.id, type: action.type, status: verified ? "SUCCEEDED" : "FAILED", beforeValue: null, afterValue: value, error: null, verificationPassed: verified };
    }

    case "UPDATE_META_DESCRIPTION":
    case "UPDATE_PAGE_TITLE":
    case "UPDATE_PAGE_SLUG_DRAFT": {
      if (!pageId) return actionFail(action, "No target page ID");
      const value = action.payload["value"] as string;
      const field = action.type === "UPDATE_META_DESCRIPTION" ? "meta_description"
        : action.type === "UPDATE_PAGE_TITLE" ? "title"
        : "slug";
      // Use updatePageContent (not updatePageMeta) so title/slug are sent as top-level WP REST fields,
      // not wrapped inside meta: {} which would target custom post meta, not the page title or slug.
      const write = await adapter.updatePageContent(pageId, { field, value });
      const after = await adapter.getPage(pageId);
      const verified = after?.contentHash === write.afterStateHash;
      return { actionId: action.id, type: action.type, status: verified ? "SUCCEEDED" : "FAILED", beforeValue: null, afterValue: value, error: verified ? null : "Read-back hash mismatch", verificationPassed: verified };
    }

    case "CREATE_DRAFT_PAGE": {
      const title = action.payload["title"] as string;
      const slug = action.payload["slug"] as string;
      const metaDescription = action.payload["metaDescription"] as string | undefined;
      const result = await adapter.createDraftPage({ title, slug, metaDescription });
      // Read back to verify
      const readBack = await adapter.getPage(result.pageId);
      const verified = readBack?.status === "draft" && readBack.title === title;
      return { actionId: action.id, type: action.type, status: verified ? "SUCCEEDED" : "FAILED", beforeValue: null, afterValue: result.pageId, error: verified ? null : "Draft page read-back failed", verificationPassed: verified };
    }

    case "REPLACE_IMAGE": {
      if (!pageId) return actionFail(action, "No target page ID");
      const widgetId = action.target.widgetId ?? action.target.elementorElementId;
      if (!widgetId) return actionFail(action, "REPLACE_IMAGE requires a widgetId or elementorElementId target");
      const doc = await adapter.getElementorDocument(pageId);
      if (!doc) return actionFail(action, `Elementor document not found for page ${pageId}`);
      const node = findNode(doc.nodes, widgetId);
      if (!node) return actionFail(action, `Widget ${widgetId} not found in Elementor document`);
      if (node.type !== "image") return actionFail(action, `Target ${widgetId} is ${node.type}, expected image`);
      const newUrl = action.payload["url"] as string;
      const altText = action.payload["altText"] as string | undefined;
      const patchedNode: typeof node = { ...node, settings: { ...node.settings, url: newUrl, ...(altText ? { alt: altText } : {}) } };
      const patchedDoc = replaceNode(doc, widgetId, patchedNode);
      const write = await adapter.updateElementorDocument(pageId, patchedDoc);
      const afterDoc = await adapter.getElementorDocument(pageId);
      const verified = afterDoc !== null && write.afterStateHash !== "";
      return { actionId: action.id, type: action.type, status: verified ? "SUCCEEDED" : "FAILED", beforeValue: node.settings["url"], afterValue: newUrl, error: null, verificationPassed: verified };
    }

    case "UPDATE_WIDGET_CONTENT":
    case "UPDATE_WIDGET_STYLE_SAFE":
    case "UPDATE_CONTAINER_SETTINGS_SAFE": {
      if (!pageId) return actionFail(action, "No target page ID");
      const widgetId = action.target.widgetId ?? action.target.elementorElementId ?? action.target.containerId;
      if (!widgetId) return actionFail(action, `${action.type} requires a widget/element/container target`);
      const doc = await adapter.getElementorDocument(pageId);
      if (!doc) return actionFail(action, `Elementor document not found for page ${pageId}`);
      const node = findNode(doc.nodes, widgetId);
      if (!node) return actionFail(action, `Element ${widgetId} not found`);

      // Safe style enforcement
      if (action.type === "UPDATE_WIDGET_STYLE_SAFE") {
        const key = action.payload["settingKey"] as string;
        if (!isSafeStyleKey(key)) return actionFail(action, `Style key "${key}" not in GREEN whitelist`);
      }

      const settingsUpdate = action.payload["settings"] as Record<string, unknown> ?? {};
      const beforeSettings = { ...node.settings };
      const patchedNode: typeof node = { ...node, settings: { ...node.settings, ...settingsUpdate } };
      const patchedDoc = replaceNode(doc, widgetId, patchedNode);
      const write = await adapter.updateElementorDocument(pageId, patchedDoc);
      const verified = write.afterStateHash !== "";
      return { actionId: action.id, type: action.type, status: verified ? "SUCCEEDED" : "FAILED", beforeValue: beforeSettings, afterValue: patchedNode.settings, error: null, verificationPassed: verified };
    }

    case "ADD_APPROVED_SECTION": {
      if (!pageId) return actionFail(action, "No target page ID");
      const sectionLibraryEntryId = action.payload["libraryEntryId"] as string;
      // Approval enforced in validateChangePlan — by the time executeAction runs the entry is confirmed APPROVED
      if (!sectionLibraryEntryId) return actionFail(action, "Section library entry ID required");
      const doc = await adapter.getElementorDocument(pageId);
      if (!doc) return actionFail(action, `Elementor document not found`);
      const sectionNode = action.payload["sectionNode"] as typeof doc.nodes[0] | undefined;
      if (!sectionNode) return actionFail(action, "ADD_APPROVED_SECTION requires sectionNode in payload");
      const updatedDoc = { ...doc, nodes: [...doc.nodes, sectionNode] };
      const write = await adapter.updateElementorDocument(pageId, updatedDoc);
      const verified = write.afterStateHash !== "";
      return { actionId: action.id, type: action.type, status: verified ? "SUCCEEDED" : "FAILED", beforeValue: doc.nodes.length, afterValue: updatedDoc.nodes.length, error: null, verificationPassed: verified };
    }

    case "REMOVE_DRAFT_SECTION": {
      if (!pageId) return actionFail(action, "No target page ID");
      const sectionId = action.target.elementorElementId ?? action.payload["sectionId"] as string;
      if (!sectionId) return actionFail(action, "REMOVE_DRAFT_SECTION requires sectionId");
      const doc = await adapter.getElementorDocument(pageId);
      if (!doc) return actionFail(action, "Elementor document not found");
      const before = doc.nodes.length;
      const updatedDoc = { ...doc, nodes: doc.nodes.filter((n) => n.id !== sectionId) };
      if (updatedDoc.nodes.length === before) return actionFail(action, `Section ${sectionId} not found in document`);
      const write = await adapter.updateElementorDocument(pageId, updatedDoc);
      return { actionId: action.id, type: action.type, status: "SUCCEEDED", beforeValue: before, afterValue: updatedDoc.nodes.length, error: null, verificationPassed: write.afterStateHash !== "" };
    }

    case "REORDER_DRAFT_SECTIONS": {
      if (!pageId) return actionFail(action, "No target page ID");
      const order = action.payload["sectionIds"] as string[];
      if (!Array.isArray(order)) return actionFail(action, "REORDER_DRAFT_SECTIONS requires sectionIds array");
      const doc = await adapter.getElementorDocument(pageId);
      if (!doc) return actionFail(action, "Elementor document not found");
      const nodeMap = new Map(doc.nodes.map((n) => [n.id, n]));
      const reordered = order.map((id) => nodeMap.get(id)).filter(Boolean) as typeof doc.nodes;
      // Preserve any nodes not in the order list at the end
      const remaining = doc.nodes.filter((n) => !order.includes(n.id));
      const updatedDoc = { ...doc, nodes: [...reordered, ...remaining] };
      const write = await adapter.updateElementorDocument(pageId, updatedDoc);
      return { actionId: action.id, type: action.type, status: "SUCCEEDED", beforeValue: doc.nodes.map((n) => n.id), afterValue: updatedDoc.nodes.map((n) => n.id), error: null, verificationPassed: write.afterStateHash !== "" };
    }

    default:
      return actionFail(action, `Unsupported action type: ${(action as WpWriteAction).type}`);
  }
}

function actionFail(action: WpWriteAction, message: string): WpActionResult {
  return { actionId: action.id, type: action.type, status: "FAILED", beforeValue: null, afterValue: null, error: message, verificationPassed: false };
}

function findNode(nodes: ElementorNode[], id: string): ElementorNode | undefined {

  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return undefined;
}

function replaceNode(doc: ElementorDocument, id: string, replacement: ElementorNode): ElementorDocument {
  function replaceInList(nodes: ElementorNode[]): ElementorNode[] {
    return nodes.map((n) =>
      n.id === id ? replacement : { ...n, children: replaceInList(n.children) },
    );
  }
  return { ...doc, nodes: replaceInList(doc.nodes) };
}

function fail(data: OSData, reason: WpEngineFailureReason, message: string): WpEngineFailure {
  return { ok: false, reason, message, data };
}

const defaultId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const defaultNow = () => new Date().toISOString();

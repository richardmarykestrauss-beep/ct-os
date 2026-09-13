/**
 * CTOS-007A audit orchestrator — the Conductor logic for a PUBLIC_PROSPECT website audit.
 *
 * Every specialist pass is a canonical AgentJob executed through the ordinary gateway
 * (`GatewayClient.execute` → gateway core → ModelRouter → provider policy/fallback → validation →
 * runs, execution logs, artifact). This module never calls a provider itself and never invents a
 * second job model: it only sequences jobs and dispatches store actions, so the Agents, Runs and
 * Audit views all read the same records the executor wrote.
 *
 * Flow: capture → A01 → A02 → (A03 ‖ A04) → A06 → synthesis. Downstream jobs receive the capture
 * artifact plus every upstream output that actually completed. One agent failing yields PARTIAL;
 * no agent completing yields NEEDS_A_HAND. Production tickets are never touched.
 */
import type { AgentJob, ArtifactType, AuditFinding, AuthUser, OSData } from "@/data/types";
import { AGENT_IDS } from "@/data/seed";
import { EMPTY, type GatewayResponse } from "@/gateway/core";
import type { ExecutionContext, GatewayClient } from "@/gateway/client";
import type { OSAction } from "@/state/os-store";
import { captureCoverage, type SiteCapture } from "@/services/site-digest";
import { applyQaVerdicts, auditCompletion, consolidateFindings, heuristicFindings, normaliseAgentFindings, qaVerdictsOf, synthesiseAuditReport, type AgentOutcome } from "@/services/website-audit";

export type AuditPhase = "A01" | "A02" | "A03" | "A04" | "A06";

export interface AuditPhaseDef {
  phase: AuditPhase;
  agentId: string;
  outputType: ArtifactType;
  title: string;
  instructions: string;
}

const RULES = [
  "EVIDENCE RULES: Only the capture digest and upstream artifacts are evidence. Quote the observed field (h1, navLinks, ctaTexts, metaDescription, textExcerpt...) in every finding's `evidence`.",
  "claimType: OBSERVED = directly present in the digest; INFERRED = deduced from a signal; PROPOSED = a recommendation not tied to a specific observation; VERIFIED only when two independent signals agree.",
  "Never claim analytics, tracking, forms, checkout, authentication or mobile rendering behaviour that the digest does not show. Never invent pages, copy or numbers.",
  "This is a read-only public audit: nothing was submitted, logged in to, purchased or changed.",
].join("\n");

const FINDING_SHAPE = "Each finding needs: id (kebab slug), category (TRAFFIC|MESSAGE|TRUST|CONVERSION|FOLLOW_UP|TECHNICAL|SEO|UX|VISUAL|OTHER), severity (CRITICAL|MAJOR|MINOR|COSMETIC), claimType, title, detail, evidence, businessImpact, affectedUrl, estimatedEffort, recommendation, serviceOpportunity (or null). Report genuine issues only — do not pad.";

export const AUDIT_PHASES: AuditPhaseDef[] = [
  {
    phase: "A01",
    agentId: AGENT_IDS.A01,
    outputType: "audit_discovery",
    title: "Discovery",
    instructions: `PUBLIC PROSPECT AUDIT — DISCOVERY PASS.\nFrom the audit_capture digest, establish what this business is, who it serves, what it offers and what the site is trying to achieve. Record trust observations and positioning notes ONLY where the digest supports them. Map the captured pages into siteStructure with a role per page. List technicalSignals visible in externalScriptHosts/hasAnalytics (label each INFERRED).\n${RULES}`,
  },
  {
    phase: "A02",
    agentId: AGENT_IDS.A02,
    outputType: "audit_architecture",
    title: "Site architecture & UX",
    instructions: `PUBLIC PROSPECT AUDIT — SITE ARCHITECTURE PASS.\nUsing the capture digest and the A01 discovery artifact, assess information architecture, navigation (navLinks), customer journeys, conversion structure and CTA architecture (ctaTexts, formCount), page structure (h1/h2) and product/service hierarchy. Produce uxFindings.\n${FINDING_SHAPE}\n${RULES}`,
  },
  {
    phase: "A03",
    agentId: AGENT_IDS.A03,
    outputType: "audit_creative",
    title: "Creative direction",
    instructions: `PUBLIC PROSPECT AUDIT — CREATIVE DIRECTION PASS.\nNo screenshots exist unless the capture's screenshots list is non-empty. If it is empty you MUST set visualVerificationStatus to "VISUAL_NOT_VERIFIED" and restrict yourself to structural evidence: content hierarchy (h1/h2 order), imagery presence (imageCount, imagesWithoutAlt), section structure, and observable design conventions in the digest. Do not describe colours, typography, spacing or visual polish. Produce structuralObservations and creativeFindings.\n${FINDING_SHAPE}\n${RULES}`,
  },
  {
    phase: "A04",
    agentId: AGENT_IDS.A04,
    outputType: "audit_content_analysis",
    title: "Content & SEO",
    instructions: `PUBLIC PROSPECT AUDIT — CONTENT PASS.\nUsing the capture digest and upstream artifacts, assess copy clarity (textExcerpt, h1), headings, metadata (title, metaDescription), CTA copy (ctaTexts), content gaps, internal linking (navLinks), content-SEO signals and brand voice consistency where observable across pages. Produce messagingAssessment, seoFindings and contentFindings.\n${FINDING_SHAPE}\n${RULES}`,
  },
  {
    phase: "A06",
    agentId: AGENT_IDS.A06,
    outputType: "audit_qa_review",
    title: "QA review",
    instructions: `PUBLIC PROSPECT AUDIT — INDEPENDENT QA PASS (runs last).\nReview EVERY finding in the upstream A02/A03/A04 artifacts against the capture digest. For each finding id give a verdict in challengedFindings: CONFIRMED (evidence present in the digest), CHALLENGED (plausible but unsupported/overstated — explain), REJECTED (contradicted by the digest, malformed, duplicate, or a claim about behaviour that was never tested: checkout, form submission, analytics, mobile rendering). Add additionalFindings only for genuine issues upstream missed (placeholder copy, failed pages in skippedUrls, contradictions between agents). Score overall trustworthiness 1–10.\n${FINDING_SHAPE}\n${RULES}`,
  },
];

// ---------------------------------------------------------------------------
// Dependencies — injected so the store (React) and tests (plain functions) share one implementation
// ---------------------------------------------------------------------------

export type CaptureResult = { ok: true; capture: SiteCapture } | { ok: false; error: string };

export interface AuditOrchestratorDeps {
  requestId: string;
  user: AuthUser;
  /** Dispatch to the canonical store; must return the post-action snapshot synchronously. */
  apply: (action: OSAction) => OSData;
  snapshot: () => OSData;
  gateway: GatewayClient;
  /** Used when the primary gateway cannot be reached at all (transport failure / not enabled). */
  fallbackGateway?: GatewayClient;
  capture: (targetUrl: string) => Promise<CaptureResult>;
  /** Supabase mode: server truth must hold the RUNNING job before the gateway reads it. */
  persist?: (data: OSData) => Promise<void>;
  newId: (prefix: string) => string;
}

export interface AuditRunSummary {
  requestId: string;
  status: OSData["websiteAuditRequests"][number]["status"];
  jobIds: Record<AuditPhase, string>;
  findings: number;
}

/** Job truth for a gateway without a server-side store: this job, its agent, its inputs, approved knowledge and skills. */
export function executionContextFor(data: OSData, job: AgentJob, user: AuthUser): ExecutionContext {
  const inputs = job.inputArtifactIds.map((id) => data.artifacts.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a);
  return {
    user,
    data: {
      ...EMPTY,
      agents: data.agents,
      agentJobs: [job],
      artifacts: inputs,
      agentRuns: data.agentRuns.filter((r) => r.jobId === job.id),
      jobApprovals: data.jobApprovals.filter((a) => a.jobId === job.id),
      knowledgeItems: data.knowledgeItems.filter((k) => k.status === "APPROVED"),
      skills: data.skills,
    },
  };
}

function transportFailed(res: GatewayResponse): boolean {
  return !res.ok && res.code === "internal" && (res.status === 0 || res.status >= 500);
}

export async function runAuditPipeline(deps: AuditOrchestratorDeps): Promise<AuditRunSummary> {
  const { requestId, user, apply, newId } = deps;
  const request0 = deps.snapshot().websiteAuditRequests.find((r) => r.id === requestId);
  if (!request0) throw new Error(`Audit request ${requestId} not found`);
  const jobIds = Object.fromEntries(AUDIT_PHASES.map((p) => [p.phase, newId("job")])) as Record<AuditPhase, string>;
  const fail = (reason: string): AuditRunSummary => {
    apply({ type: "AUDIT_FAILED", requestId, reason, actor: user });
    return { requestId, status: "FAILED", jobIds, findings: 0 };
  };

  if (request0.auditType !== "PUBLIC_PROSPECT") return fail("CLIENT_DEEP_AUDIT is not available in this release.");

  // 1. Capture (server-side, SSRF-safe, bounded) → audit_capture artifact
  apply({ type: "AUDIT_UPDATE", requestId, patch: { status: "CAPTURING", progressMessage: `Capturing ${request0.targetUrl} (homepage + key pages)…` }, actor: user });
  let captureRes: CaptureResult;
  try {
    captureRes = await deps.capture(request0.targetUrl);
  } catch (err) {
    captureRes = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!captureRes.ok) return fail(`Capture failed: ${captureRes.error}`);
  const capture = captureRes.capture;
  const captureArtifactId = newId("art");
  apply({ type: "AUDIT_CAPTURED", requestId, capture, artifactId: captureArtifactId, actor: user });

  // 2. Canonical AgentJobs (QUEUED) for every specialist pass — visible on Agents/Runs immediately
  apply({ type: "AUDIT_JOBS_CREATED", requestId, captureArtifactId, jobs: AUDIT_PHASES.map((p) => ({ id: jobIds[p.phase], agentId: p.agentId, outputType: p.outputType, instructions: p.instructions, title: p.title })), actor: user });

  let gateway = deps.gateway;
  const outputOf = (phase: AuditPhase): string | null => {
    const job = deps.snapshot().agentJobs.find((j) => j.id === jobIds[phase]);
    return job?.status === "COMPLETED" ? job.outputArtifactId : null;
  };

  const runPhase = async (phase: AuditPhase, upstream: AuditPhase[]): Promise<void> => {
    const def = AUDIT_PHASES.find((p) => p.phase === phase)!;
    const jobId = jobIds[phase];
    const inputArtifactIds = [captureArtifactId, ...upstream.map(outputOf).filter((id): id is string => !!id)];
    let data = apply({ type: "AUDIT_JOB_START", jobId, inputArtifactIds, actor: user });
    const job = data.agentJobs.find((j) => j.id === jobId);
    if (!job || job.status !== "RUNNING") {
      apply({ type: "AUDIT_UPDATE", requestId, patch: { progressMessage: `${phase} could not start (${job?.status ?? "missing"})` }, actor: user });
      return;
    }
    if (deps.persist) {
      try { await deps.persist(data); } catch { /* surfaced in Settings; the gateway reports not_found if the job is missing */ }
    }
    const artifactTitle = `${phase} ${def.title} — audit ${new URL(request0.targetUrl).hostname}`;
    let response = await gateway.execute(jobId, { artifactTitle, context: executionContextFor(data, job, user) });
    if (transportFailed(response) && deps.fallbackGateway && gateway !== deps.fallbackGateway) {
      apply({ type: "AUDIT_UPDATE", requestId, patch: { progressMessage: `Execution gateway unreachable (${response.ok ? "" : response.message}) — continuing on the embedded gateway (stub providers, labelled as such).` }, actor: user });
      gateway = deps.fallbackGateway;
      data = deps.snapshot();
      response = await gateway.execute(jobId, { artifactTitle, context: executionContextFor(data, data.agentJobs.find((j) => j.id === jobId)!, user) });
    }
    apply({ type: "APPLY_EXECUTION", jobId, response, actor: user });
    apply({ type: "AUDIT_JOB_SETTLE", jobId, requestId, actor: user });
  };

  apply({ type: "AUDIT_UPDATE", requestId, patch: { status: "RUNNING", progressMessage: `Captured ${capture.pages.length} page(s). Specialist agents queued: A01 → A02 → A03 ‖ A04 → A06.` }, actor: user });
  await runPhase("A01", []);
  await runPhase("A02", ["A01"]);
  await Promise.all([runPhase("A03", ["A01", "A02"]), runPhase("A04", ["A01", "A02"])]);
  const upstreamDone = (["A01", "A02", "A03", "A04"] as AuditPhase[]).some((p) => outputOf(p));
  if (upstreamDone) await runPhase("A06", ["A01", "A02", "A03", "A04"]);
  else apply({ type: "CANCEL_JOB", jobId: jobIds.A06, reason: "No upstream audit output to review", actor: user });

  // 3. Normalise findings from real artifacts; apply A06 verdicts; synthesise the report
  const data = deps.snapshot();
  const request = data.websiteAuditRequests.find((r) => r.id === requestId)!;
  const artifactOf = (phase: AuditPhase) => {
    const id = outputOf(phase);
    return id ? (data.artifacts.find((a) => a.id === id) ?? null) : null;
  };
  const ctx = { requestId, projectId: request.projectId, targetUrl: request.targetUrl };
  let findings: AuditFinding[] = [];
  let idMap: Record<string, string> = {};
  let rejectedByValidation = 0;
  for (const phase of ["A02", "A03", "A04"] as AuditPhase[]) {
    const art = artifactOf(phase);
    if (!art) continue;
    const n = normaliseAgentFindings(art.type, art.content, { ...ctx, agentId: art.createdByAgentId ?? AUDIT_PHASES.find((p) => p.phase === phase)!.agentId });
    findings = [...findings, ...n.findings];
    idMap = { ...idMap, ...n.idMap };
    rejectedByValidation += n.rejected.length;
  }
  const qaArt = artifactOf("A06");
  const qa = qaArt ? applyQaVerdicts(findings, qaVerdictsOf(qaArt.content), idMap) : { findings, rejectedCount: 0, challengedCount: 0 };
  findings = qa.findings;
  if (qaArt) {
    const extra = normaliseAgentFindings(qaArt.type, qaArt.content, { ...ctx, agentId: AGENT_IDS.A06 });
    findings = [...findings, ...extra.findings];
    rejectedByValidation += extra.rejected.length;
  }
  const outcomes: AgentOutcome[] = AUDIT_PHASES.map((p) => {
    const job = data.agentJobs.find((j) => j.id === jobIds[p.phase])!;
    const winner = data.agentRuns.find((r) => r.jobId === job.id && r.status === "SUCCEEDED") ?? null;
    return { agentId: p.agentId, jobId: job.id, status: job.status, providerId: winner?.providerId ?? null, model: winner?.model ?? null, artifactId: job.outputArtifactId };
  });
  const qaContent = qaArt?.content as { summary?: string; qualityScore?: number } | undefined;
  const discovery = artifactOf("A01")?.content as { summary?: string } | undefined;
  // Consolidate: one client-facing issue per root cause; raw rows kept for evidence; heuristics that
  // duplicate a specialist finding merge as supporting evidence, the rest stand alone.
  const heuristics = heuristicFindings(capture, requestId, request.projectId);
  const merged = consolidateFindings(findings, heuristics, { partialCoverage: captureCoverage(capture).partial, newId });
  const report = synthesiseAuditReport({
    request,
    capture,
    findings: merged.consolidated,
    heuristics: [],
    rawFindings: merged.raw,
    outcomes,
    qaSummary: qaContent?.summary ?? null,
    qaQualityScore: typeof qaContent?.qualityScore === "number" ? qaContent.qualityScore : null,
    rejectedCount: qa.rejectedCount + rejectedByValidation,
    challengedCount: qa.challengedCount,
    discoverySummary: discovery?.summary ?? null,
  });
  const { status } = auditCompletion(outcomes);
  // The findings table holds both: RAW rows (specialist evidence) and CONSOLIDATED rows (the same
  // client-facing list the report carries), so UI and report counts can never diverge.
  apply({ type: "AUDIT_COMPLETE", requestId, status, findings: [...merged.raw, ...merged.consolidated], reportContent: report.content, summary: report.summary, serviceOpportunities: report.serviceOpportunities, actor: user });
  return { requestId, status, jobIds, findings: merged.consolidated.length };
}

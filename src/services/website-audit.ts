/**
 * CTOS-007A: public website audit — request lifecycle, findings normalisation and synthesis.
 *
 * Execution itself is NOT here: specialist agents run as canonical AgentJobs through the gateway
 * (see services/audit-orchestrator.ts). This module is pure: OSData/artifact content in, records out.
 *
 * Security constraints:
 *   - URLs pass validateAuditUrl before a request exists; the server re-checks (DNS-resolved) on capture
 *   - Never submits forms, never authenticates, never mutates the target
 *   - Findings are rejected when malformed — a run never completes on garbage
 *   - Heuristic findings are deterministic, carry agentId null and are labelled HEURISTIC
 */
import { z } from "zod";
import type { AgentJob, AuditFinding, AuditStatus, OSData, ServiceOpportunity, WebsiteAuditRequest } from "@/data/types";
import { newId, nowIso } from "@/lib/utils";
import { validateAuditUrl } from "@/lib/audit-url";
import { captureCoverage, heuristicSignals, type SiteCapture } from "@/services/site-digest";

// ---------------------------------------------------------------------------
// Request lifecycle
// ---------------------------------------------------------------------------

export interface AuditRequestInput {
  targetUrl: string;
  auditType: WebsiteAuditRequest["auditType"];
  projectId?: string | null;
  requestedById?: string | null;
  requestedByName?: string | null;
  id?: string;
}

/** Validate the URL and create a PENDING audit request. Does NOT start the audit. */
export function createAuditRequest(data: OSData, input: AuditRequestInput): { ok: true; data: OSData; request: WebsiteAuditRequest } | { ok: false; reason: string; data: OSData } {
  const validation = validateAuditUrl(input.targetUrl);
  if (!validation.ok) return { ok: false, reason: validation.reason, data };
  const now = nowIso();
  const request: WebsiteAuditRequest = {
    id: input.id ?? newId("audit"),
    projectId: input.projectId ?? null,
    targetUrl: validation.normalised,
    auditType: input.auditType,
    status: "PENDING",
    progressLog: [],
    auditJobIds: [],
    resultArtifactId: null,
    failureReason: null,
    reviewedAt: null,
    requestedById: input.requestedById ?? null,
    requestedByName: input.requestedByName ?? null,
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, data: { ...data, websiteAuditRequests: [...data.websiteAuditRequests, request] }, request };
}

export interface AuditRequestPatch {
  status?: AuditStatus;
  progressMessage?: string;
  resultArtifactId?: string | null;
  failureReason?: string | null;
  auditJobIds?: string[];
  reviewedAt?: string | null;
}

/** Update audit request fields and append to the progress log. No-op for unknown ids. */
export function updateAuditRequest(data: OSData, requestId: string, patch: AuditRequestPatch): OSData {
  const now = nowIso();
  return {
    ...data,
    websiteAuditRequests: data.websiteAuditRequests.map((r) =>
      r.id !== requestId
        ? r
        : {
            ...r,
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.resultArtifactId !== undefined ? { resultArtifactId: patch.resultArtifactId } : {}),
            ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
            ...(patch.auditJobIds !== undefined ? { auditJobIds: patch.auditJobIds } : {}),
            ...(patch.reviewedAt !== undefined ? { reviewedAt: patch.reviewedAt } : {}),
            progressLog: patch.progressMessage ? [...r.progressLog, patch.progressMessage] : r.progressLog,
            updatedAt: now,
          },
    ),
  };
}

/** An audit job belongs to a WebsiteAuditRequest, never to a production ticket. */
export function isAuditJob(data: OSData, job: Pick<AgentJob, "id" | "ticketId">): boolean {
  if (job.ticketId) return false;
  return data.websiteAuditRequests.some((r) => r.auditJobIds.includes(job.id));
}

export function auditRequestForJob(data: OSData, jobId: string): WebsiteAuditRequest | null {
  return data.websiteAuditRequests.find((r) => r.auditJobIds.includes(jobId)) ?? null;
}

// ---------------------------------------------------------------------------
// Findings normalisation — one schema, every agent, malformed items rejected
// ---------------------------------------------------------------------------

const CATEGORY = z.enum(["TRAFFIC", "MESSAGE", "TRUST", "CONVERSION", "FOLLOW_UP", "TECHNICAL", "SEO", "UX", "VISUAL", "OTHER"]);
const SEVERITY = z.enum(["CRITICAL", "MAJOR", "MINOR", "COSMETIC"]);
const CLAIM = z.enum(["OBSERVED", "INFERRED", "PROPOSED", "VERIFIED"]);

const FINDING = z.object({
  id: z.string().min(1),
  category: CATEGORY,
  severity: SEVERITY,
  claimType: CLAIM,
  title: z.string().min(3),
  detail: z.string().min(3),
  evidence: z.string().min(3),
  businessImpact: z.string().nullable().optional(),
  affectedUrl: z.string().nullable().optional(),
  estimatedEffort: z.string().nullable().optional(),
  recommendation: z.string().nullable().optional(),
  serviceOpportunity: z.object({ service: z.string().min(1), rationale: z.string().min(1), estimatedImpact: z.enum(["HIGH", "MEDIUM", "LOW"]) }).nullable().optional(),
});

const FINDING_FIELDS: Record<string, string> = {
  audit_architecture: "uxFindings",
  audit_creative: "creativeFindings",
  audit_content_analysis: "contentFindings",
  audit_qa_review: "additionalFindings",
};

export interface NormalisedFindings {
  findings: AuditFinding[];
  rejected: Array<{ index: number; reason: string }>;
  /** The agent's own finding ids (before we re-key them) → normalised finding id. */
  idMap: Record<string, string>;
}

/** Extract an agent artifact's findings into AuditFinding rows. Malformed items are rejected, not repaired. */
export function normaliseAgentFindings(artifactType: string, content: unknown, ctx: { agentId: string; requestId: string; projectId: string | null; targetUrl: string }): NormalisedFindings {
  const field = FINDING_FIELDS[artifactType];
  const raw = field && content && typeof content === "object" ? (content as Record<string, unknown>)[field] : null;
  const out: NormalisedFindings = { findings: [], rejected: [], idMap: {} };
  if (!Array.isArray(raw)) return out;
  const now = nowIso();
  raw.forEach((item, index) => {
    const parsed = FINDING.safeParse(item);
    if (!parsed.success) {
      out.rejected.push({ index, reason: parsed.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      return;
    }
    const f = parsed.data;
    // A03 may not claim verified visual quality without screenshot evidence.
    const claimType = artifactType === "audit_creative" && f.category === "VISUAL" && f.claimType === "VERIFIED" ? "INFERRED" : f.claimType;
    const id = newId("afind");
    out.idMap[f.id] = id;
    out.findings.push({
      id,
      auditRequestId: ctx.requestId,
      projectId: ctx.projectId,
      agentId: ctx.agentId,
      category: f.category,
      severity: f.severity,
      claimType,
      title: f.title,
      detail: f.detail,
      evidence: f.evidence,
      businessImpact: f.businessImpact ?? null,
      affectedUrl: f.affectedUrl ?? ctx.targetUrl,
      estimatedEffort: f.estimatedEffort ?? null,
      recommendation: f.recommendation ?? null,
      serviceOpportunity: f.serviceOpportunity ?? null,
      createdAt: now,
    });
  });
  return out;
}

export interface QaVerdict {
  findingId: string;
  verdict: "CONFIRMED" | "CHALLENGED" | "REJECTED";
  reason: string;
}

export function qaVerdictsOf(content: unknown): QaVerdict[] {
  const raw = content && typeof content === "object" ? (content as { challengedFindings?: unknown }).challengedFindings : null;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is QaVerdict => !!v && typeof v === "object" && typeof (v as QaVerdict).findingId === "string" && ["CONFIRMED", "CHALLENGED", "REJECTED"].includes((v as QaVerdict).verdict) && typeof (v as QaVerdict).reason === "string");
}

/**
 * Apply A06's verdicts. REJECTED findings are removed; CHALLENGED findings are kept but downgraded
 * (VERIFIED/OBSERVED → INFERRED) and annotated; CONFIRMED findings are annotated. Unknown ids ignored.
 */
export function applyQaVerdicts(findings: AuditFinding[], verdicts: QaVerdict[], idMap: Record<string, string>): { findings: AuditFinding[]; rejectedCount: number; challengedCount: number } {
  const byId = new Map<string, QaVerdict>();
  for (const v of verdicts) byId.set(idMap[v.findingId] ?? v.findingId, v);
  let rejectedCount = 0;
  let challengedCount = 0;
  const kept: AuditFinding[] = [];
  for (const f of findings) {
    const v = byId.get(f.id);
    if (!v) { kept.push({ ...f, qaStatus: "UNREVIEWED" }); continue; }
    if (v.verdict === "REJECTED") { rejectedCount++; continue; }
    if (v.verdict === "CHALLENGED") {
      challengedCount++;
      kept.push({ ...f, claimType: f.claimType === "PROPOSED" ? "PROPOSED" : "INFERRED", qaStatus: "CHALLENGED", detail: `${f.detail} [QA challenged: ${v.reason}]` });
      continue;
    }
    kept.push({ ...f, qaStatus: "CONFIRMED", detail: `${f.detail} [QA confirmed]` });
  }
  return { findings: kept, rejectedCount, challengedCount };
}

/** A06 notes about duplication/consistency describe the audit, not the website — they are evidence, not defects. */
export function isQaMetaNote(f: Pick<AuditFinding, "title" | "detail">): boolean {
  return /duplicat|repeated (across|by)|same (issue|root)|consolidat|overlap|redundant finding|contradict|already (noted|reported)/i.test(`${f.title} ${f.detail}`);
}

// ---------------------------------------------------------------------------
// Consolidation — one client-facing issue per root cause, provenance retained
// ---------------------------------------------------------------------------

const ROOT_ISSUE_RULES: Array<{ key: string; re: RegExp }> = [
  { key: "alt-text", re: /\balt\b.*(text|attribute|image)|image.*\balt\b/i },
  { key: "h1", re: /\bh1\b/i },
  { key: "meta-description", re: /meta[- ]description/i },
  { key: "title-tag", re: /title tag|<title>|page title|meta title/i },
  { key: "analytics", re: /analytics|tracking (script|pixel|code)|tag manager|gtm\b|ga4|pixel/i },
  { key: "https", re: /\bhttps\b|\bssl\b|\btls\b|not secure/i },
  { key: "social-proof", re: /testimonial|social proof|reviews?\b|case stud|client logo/i },
  { key: "external-order-portal", re: /order online|external (order|portal)|third[- ]party (order|portal|store)|offsite (order|checkout)|leaves the site to order/i },
  { key: "cta", re: /call[- ]to[- ]action|\bcta\b/i },
  { key: "contact-details", re: /contact (details|information|info|number|mechanism)|phone number|no (phone|email)/i },
  { key: "navigation", re: /\bnavigation\b|\bnav\b|menu structure/i },
  { key: "mobile", re: /mobile|responsive/i },
  { key: "page-speed", re: /page speed|load time|performance/i },
  { key: "internal-linking", re: /internal link/i },
  { key: "thin-content", re: /thin content|word count|too little (copy|content)|placeholder (copy|text|content)|lorem ipsum/i },
];

const STOP = new Set(["the", "a", "an", "of", "on", "in", "to", "is", "are", "and", "or", "for", "with", "no", "not", "missing", "lack", "lacks", "lacking", "page", "site", "website", "homepage", "has", "have", "does", "do", "any", "this", "that", "there"]);

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Root-issue key from wording; null when no rule matches (falls back to title similarity). */
export function rootIssueKey(f: Pick<AuditFinding, "title" | "detail">): string | null {
  const probe = `${f.title}. ${f.detail}`;
  for (const r of ROOT_ISSUE_RULES) if (r.re.test(f.title) || r.re.test(probe.slice(0, 220))) return r.key;
  return null;
}

const SEV_ORDER: Record<AuditFinding["severity"], number> = { CRITICAL: 3, MAJOR: 2, MINOR: 1, COSMETIC: 0 };
const CLAIM_ORDER: Record<AuditFinding["claimType"], number> = { VERIFIED: 3, OBSERVED: 2, INFERRED: 1, PROPOSED: 0 };

export interface ConsolidationResult {
  /** Client-facing canonical issues (kind CONSOLIDATED). */
  consolidated: AuditFinding[];
  /** Every input finding, marked RAW (specialist + heuristic), for evidence/debugging. */
  raw: AuditFinding[];
  /** Raw ids that were merged as supporting evidence into another issue. */
  mergedIds: string[];
  /** A06 meta-notes excluded from the client-facing list (still in raw). */
  qaNoteIds: string[];
}

/**
 * Group substantially equivalent findings (same root-issue key, or same category with similar titles)
 * into one canonical finding. Heuristic rows only merge as supporting evidence; a heuristic that no
 * specialist reported stays as its own finding. Nothing is discarded: raw rows are returned intact.
 */
export function consolidateFindings(specialist: AuditFinding[], heuristics: AuditFinding[], opts: { partialCoverage?: boolean; newId?: (prefix: string) => string } = {}): ConsolidationResult {
  const mkId = opts.newId ?? newId;
  const all = [...specialist, ...heuristics].map((f) => ({ ...f, kind: "RAW" as const }));
  const qaNoteIds = specialist.filter((f) => f.agentId === "agent_06" && isQaMetaNote(f)).map((f) => f.id);
  const candidates = all.filter((f) => !qaNoteIds.includes(f.id));
  const groups: AuditFinding[][] = [];
  const keyOf = new Map<string, string | null>();
  for (const f of candidates) keyOf.set(f.id, rootIssueKey(f));
  for (const f of candidates) {
    const key = keyOf.get(f.id) ?? null;
    let group = key ? groups.find((g) => keyOf.get(g[0].id) === key) : undefined;
    if (!group) {
      const t = tokens(f.title);
      group = groups.find((g) => keyOf.get(g[0].id) === null && g[0].category === f.category && jaccard(tokens(g[0].title), t) >= 0.6);
    }
    if (group) group.push(f);
    else groups.push([f]);
  }
  const now = nowIso();
  const mergedIds: string[] = [];
  const consolidated = groups.map((g) => {
    const specialists = g.filter((f) => f.agentId !== null);
    const primaryPool = specialists.length ? specialists : g;
    const primary = [...primaryPool].sort((a, b) => SEV_ORDER[b.severity] - SEV_ORDER[a.severity] || CLAIM_ORDER[b.claimType] - CLAIM_ORDER[a.claimType])[0];
    if (g.length === 1) {
      const solo: AuditFinding = { ...primary, id: mkId("afind"), kind: "CONSOLIDATED", contributors: [primary.agentId ?? "heuristic"], sourceFindingIds: [primary.id], affectedUrls: primary.affectedUrl ? [primary.affectedUrl] : [], qaStatus: primary.qaStatus ?? (primary.agentId ? "UNREVIEWED" : undefined), claimType: opts.partialCoverage && primary.claimType === "VERIFIED" ? "OBSERVED" : primary.claimType, createdAt: now };
      return solo;
    }
    for (const f of g) if (f.id !== primary.id) mergedIds.push(f.id);
    const contributors = Array.from(new Set(g.map((f) => f.agentId ?? "heuristic")));
    const label = (f: AuditFinding) => (f.agentId ? f.agentId.replace(/^agent_/, "A") : "Heuristic");
    const severity = g.reduce((m, f) => (SEV_ORDER[f.severity] > SEV_ORDER[m] ? f.severity : m), primary.severity);
    let claimType = specialists.reduce((m, f) => (CLAIM_ORDER[f.claimType] > CLAIM_ORDER[m] ? f.claimType : m), primary.claimType);
    if (opts.partialCoverage && claimType === "VERIFIED") claimType = "OBSERVED";
    const qaStatuses = specialists.map((f) => f.qaStatus).filter((s): s is NonNullable<typeof s> => !!s);
    const qaStatus = qaStatuses.includes("CONFIRMED") ? "CONFIRMED" : qaStatuses.includes("CHALLENGED") ? "CHALLENGED" : specialists.length ? "UNREVIEWED" : undefined;
    const uniq = (xs: Array<string | null>) => Array.from(new Set(xs.filter((x): x is string => !!x && x.trim().length > 0)));
    const businessImpact = uniq(g.map((f) => f.businessImpact)).sort((a, b) => b.length - a.length)[0] ?? null;
    const recommendations = uniq(g.map((f) => f.recommendation));
    return {
      ...primary,
      id: mkId("afind"),
      kind: "CONSOLIDATED" as const,
      agentId: primary.agentId,
      severity,
      claimType,
      title: primary.title,
      detail: `${primary.detail} Reported independently by ${contributors.map((c) => (c === "heuristic" ? "the heuristic check" : c.replace(/^agent_/, "A"))).join(", ")}.`,
      evidence: g.map((f) => `[${label(f)}] ${f.evidence}`).join(" | "),
      businessImpact,
      recommendation: recommendations.length ? recommendations.join(" ") : null,
      affectedUrl: primary.affectedUrl,
      affectedUrls: uniq(g.map((f) => f.affectedUrl)),
      estimatedEffort: primary.estimatedEffort,
      serviceOpportunity: g.map((f) => f.serviceOpportunity).find((s) => s) ?? null,
      contributors,
      sourceFindingIds: g.map((f) => f.id),
      qaStatus,
      createdAt: now,
    } satisfies AuditFinding;
  });
  return { consolidated, raw: all, mergedIds, qaNoteIds };
}

// ---------------------------------------------------------------------------
// Heuristic findings — deterministic supporting evidence, never presented as agent work
// ---------------------------------------------------------------------------

const HEURISTIC_RULES: Record<string, Omit<AuditFinding, "id" | "auditRequestId" | "projectId" | "agentId" | "evidence" | "affectedUrl" | "createdAt">> = {
  no_h1: { category: "MESSAGE", severity: "MAJOR", claimType: "OBSERVED", title: "No H1 heading on homepage", detail: "The homepage has no <h1>, which weakens both SEO and the primary value proposition.", businessImpact: "Missing H1 degrades ranking potential and removes the above-fold hook.", estimatedEffort: "15 minutes", recommendation: "Add an H1 with a clear value proposition above the fold.", serviceOpportunity: null },
  meta_description: { category: "SEO", severity: "MINOR", claimType: "OBSERVED", title: "Meta description missing or too short", detail: "No meta description with meaningful content (≥20 chars) on the homepage.", businessImpact: "Search engines show auto-generated snippets, reducing click-through.", estimatedEffort: "15 minutes", recommendation: "Add a 120–160 character meta description.", serviceOpportunity: null },
  no_cta: { category: "CONVERSION", severity: "MAJOR", claimType: "INFERRED", title: "Primary CTA not clearly identified", detail: "No call-to-action link or button text pattern was detected on the homepage.", businessImpact: "Without a clear CTA visitors have no guided next step.", estimatedEffort: "30 minutes", recommendation: "Add a prominent CTA above the fold (e.g. 'Get a Quote').", serviceOpportunity: { service: "Conversion Optimisation", rationale: "No clear CTA detected", estimatedImpact: "HIGH" } },
  no_analytics: { category: "TRAFFIC", severity: "MINOR", claimType: "INFERRED", title: "No analytics tracking detected", detail: "No common analytics script was found on the homepage.", businessImpact: "No baseline to measure marketing performance or conversions.", estimatedEffort: "1–2 hours", recommendation: "Install GA4 via Google Tag Manager.", serviceOpportunity: { service: "Analytics & Tracking Setup", rationale: "No analytics baseline detected", estimatedImpact: "MEDIUM" } },
  no_contact: { category: "FOLLOW_UP", severity: "MINOR", claimType: "INFERRED", title: "No contact mechanism detected on homepage", detail: "No phone, email, WhatsApp or form signal was found on the homepage.", businessImpact: "Visitors who want to act have no clear path.", estimatedEffort: "30 minutes", recommendation: "Add contact details to the header or footer.", serviceOpportunity: { service: "Lead Capture Form", rationale: "No contact mechanism visible", estimatedImpact: "MEDIUM" } },
  no_social_proof: { category: "TRUST", severity: "MAJOR", claimType: "OBSERVED", title: "No social proof detected on homepage", detail: "No testimonial, rating or review markup was found on the homepage.", businessImpact: "Absent social proof reduces trust and increases bounce.", estimatedEffort: "1–2 hours", recommendation: "Add a testimonials section or third-party review widget.", serviceOpportunity: { service: "Trust & Credibility Section", rationale: "Social proof absent", estimatedImpact: "HIGH" } },
  alt_text: { category: "SEO", severity: "MINOR", claimType: "OBSERVED", title: "Most images lack alt text", detail: "More than half of the homepage images have no alt attribute.", businessImpact: "Accessibility and image-search visibility suffer.", estimatedEffort: "1 hour", recommendation: "Add descriptive alt text to content images.", serviceOpportunity: null },
  no_https: { category: "TECHNICAL", severity: "CRITICAL", claimType: "OBSERVED", title: "Site is not served over HTTPS", detail: "The homepage was captured over plain HTTP.", businessImpact: "Browsers warn users; Google penalises non-HTTPS sites.", estimatedEffort: "1–4 hours", recommendation: "Install an SSL certificate and force HTTPS.", serviceOpportunity: null },
};

/** Deterministic checks over the homepage digest. agentId is null and evidence is labelled HEURISTIC. */
export function heuristicFindings(capture: SiteCapture, requestId: string, projectId: string | null): AuditFinding[] {
  const home = capture.pages[0];
  if (!home) return [];
  const now = nowIso();
  return heuristicSignals(home).flatMap((s) => {
    const rule = HEURISTIC_RULES[s.key];
    if (!rule) return [];
    return [{ ...rule, id: newId("afind"), auditRequestId: requestId, projectId, agentId: null, evidence: `${s.observed} (HEURISTIC — deterministic check over the capture digest, not agent analysis)`, affectedUrl: home.url, createdAt: now }];
  });
}

// ---------------------------------------------------------------------------
// Synthesis — website_audit_report@1 from normalised findings. No new facts are invented here.
// ---------------------------------------------------------------------------

export interface AgentOutcome {
  agentId: string;
  jobId: string;
  status: AgentJob["status"];
  providerId: string | null;
  model: string | null;
  artifactId: string | null;
}

export interface SynthesisInput {
  request: WebsiteAuditRequest;
  capture: SiteCapture;
  /** Client-facing findings (consolidated). */
  findings: AuditFinding[];
  /** Heuristic rows that stand alone (no specialist duplicate). Merged ones live inside `findings`. */
  heuristics: AuditFinding[];
  /** Every raw specialist + heuristic row, for the evidence appendix and the raw count. */
  rawFindings?: AuditFinding[];
  outcomes: AgentOutcome[];
  qaSummary: string | null;
  qaQualityScore: number | null;
  rejectedCount: number;
  challengedCount: number;
  discoverySummary: string | null;
}

export type AuditCompletion = "COMPLETE" | "PARTIAL" | "HEURISTIC_ONLY";

const SEV_RANK: Record<AuditFinding["severity"], number> = { CRITICAL: 0, MAJOR: 1, MINOR: 2, COSMETIC: 3 };
const PILLARS: AuditFinding["category"][] = ["TRAFFIC", "MESSAGE", "TRUST", "CONVERSION", "FOLLOW_UP"];

export function auditCompletion(outcomes: AgentOutcome[]): { completion: AuditCompletion; status: Extract<AuditStatus, "COMPLETE" | "PARTIAL" | "NEEDS_A_HAND"> } {
  const succeeded = outcomes.filter((o) => o.status === "COMPLETED").length;
  if (succeeded === outcomes.length && outcomes.length > 0) return { completion: "COMPLETE", status: "COMPLETE" };
  if (succeeded === 0) return { completion: "HEURISTIC_ONLY", status: "NEEDS_A_HAND" };
  return { completion: "PARTIAL", status: "PARTIAL" };
}

export function synthesiseAuditReport(input: SynthesisInput): { content: Record<string, unknown>; summary: string; serviceOpportunities: ServiceOpportunity[]; completion: AuditCompletion } {
  const { completion } = auditCompletion(input.outcomes);
  const coverage = captureCoverage(input.capture);
  // Client-facing list: consolidated findings plus stand-alone heuristics, one row per root issue.
  const ids = new Set(input.findings.map((f) => f.id));
  const all = [...input.findings, ...input.heuristics.filter((h) => !ids.has(h.id))].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const raw = input.rawFindings ?? [];
  const byPillar = Object.fromEntries(PILLARS.map((p) => [p, all.filter((f) => f.category === p).length])) as Record<string, number>;
  const critical = all.filter((f) => f.severity === "CRITICAL").length;
  const major = all.filter((f) => f.severity === "MAJOR").length;
  const oppMap = new Map<string, ServiceOpportunity>();
  for (const f of all) if (f.serviceOpportunity && !oppMap.has(f.serviceOpportunity.service)) oppMap.set(f.serviceOpportunity.service, f.serviceOpportunity);
  const serviceOpportunities = [...oppMap.values()].slice(0, 20);
  const failed = input.outcomes.filter((o) => o.status !== "COMPLETED");
  const evidenceGaps: string[] = [];
  if (coverage.partial) evidenceGaps.push(`Partial coverage: ${coverage.pagesCaptured} of ${coverage.pagesDiscovered} discovered pages captured — conclusions describe the captured pages, not the whole site. Not captured: ${coverage.notCaptured.slice(0, 10).join(", ")}${coverage.notCaptured.length > 10 ? ", …" : ""}.`);
  if (input.capture.screenshots.length === 0) evidenceGaps.push("No screenshots captured — visual design quality is VISUAL_NOT_VERIFIED.");
  for (const s of input.capture.skippedUrls) evidenceGaps.push(`Page not captured: ${s.url} (${s.reason})`);
  for (const o of failed) evidenceGaps.push(`${o.agentId} did not complete (${o.status}) — its perspective is missing.`);
  evidenceGaps.push("No form submission, checkout, authentication or analytics verification was performed (public read-only audit).");
  const verdict =
    critical > 0 ? `${critical} critical issue(s) block conversion or trust and should be fixed first.` : major > 0 ? `No critical blockers; ${major} major issue(s) limit results.` : all.length ? "Only minor and cosmetic issues found." : "No specialist findings were produced.";
  const rawNote = raw.length && raw.length !== all.length ? ` Consolidated from ${raw.length} raw specialist/heuristic observations.` : "";
  const coverageNote = ` Coverage: ${coverage.pagesCaptured} of ${coverage.pagesDiscovered} discovered page(s) captured${coverage.partial ? " (partial — not site-wide)" : ""}.`;
  const summary = `${completion === "COMPLETE" ? "Complete" : completion === "PARTIAL" ? "PARTIAL" : "HEURISTIC ONLY"} audit of ${input.request.targetUrl}: ${all.length} finding(s) from ${input.outcomes.filter((o) => o.status === "COMPLETED").length}/${input.outcomes.length} specialist agents (${critical} critical, ${major} major).${rawNote}${coverageNote} ${verdict}${input.qaQualityScore !== null ? ` QA quality score ${input.qaQualityScore}/10; ${input.rejectedCount} rejected, ${input.challengedCount} challenged.` : ""}`;
  const toReport = (f: AuditFinding) => ({ id: f.id, agentId: f.agentId, category: f.category, severity: f.severity, claimType: f.claimType, title: f.title, detail: f.detail, evidence: f.evidence, businessImpact: f.businessImpact, affectedUrl: f.affectedUrl, estimatedEffort: f.estimatedEffort, recommendation: f.recommendation, serviceOpportunity: f.serviceOpportunity, ...(f.contributors ? { contributors: f.contributors } : {}), ...(f.sourceFindingIds ? { sourceFindingIds: f.sourceFindingIds } : {}), ...(f.affectedUrls?.length ? { affectedUrls: f.affectedUrls } : {}), ...(f.qaStatus ? { qaStatus: f.qaStatus } : {}) });
  const content: Record<string, unknown> = {
    targetUrl: input.request.targetUrl,
    auditType: input.request.auditType,
    summary,
    completionStatus: completion,
    overallVerdict: verdict,
    findings: all.slice(0, 100).map(toReport),
    rawFindingCount: raw.length || all.length,
    consolidatedFindingCount: all.length,
    rawFindings: raw.slice(0, 200).map((f) => ({ id: f.id, agentId: f.agentId, category: f.category, severity: f.severity, claimType: f.claimType, title: f.title, evidence: f.evidence, ...(f.qaStatus ? { qaStatus: f.qaStatus } : {}) })),
    coverage,
    topIssues: all.slice(0, 10).map((f) => `[${f.severity}] ${f.title}`),
    recommendedActions: all.filter((f) => f.recommendation).slice(0, 20).map((f) => f.recommendation as string),
    serviceOpportunities,
    humanReviewQuestions: [
      "Does the client have testimonials, reviews or case studies not visible on the site?",
      "Is analytics installed via a tag manager or server-side (not visible in public HTML)?",
      ...(input.capture.screenshots.length === 0 ? ["Should a screenshot-backed visual review be commissioned?"] : []),
    ],
    evidenceGaps,
    visualVerificationStatus: input.capture.screenshots.length ? "VISUAL_VERIFIED" : "VISUAL_NOT_VERIFIED",
    capturedPages: input.capture.pages.map((p) => p.url),
    capturedAt: input.capture.capturedAt,
    pillarCounts: byPillar,
    agentOutcomes: input.outcomes,
    heuristicFindingIds: input.heuristics.filter((h) => !ids.has(h.id)).map((f) => f.id),
    discoverySummary: input.discoverySummary,
    qaSummary: input.qaSummary,
  };
  return { content, summary, serviceOpportunities, completion };
}

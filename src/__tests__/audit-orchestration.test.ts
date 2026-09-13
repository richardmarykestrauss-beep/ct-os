/**
 * CTOS-007A: end-to-end audit orchestration over the real reducer and the real gateway core.
 *
 * Drives `runAuditPipeline` exactly as the store does (apply = reduceOS + dispatch) with the embedded
 * gateway over stub providers — no network, no paid calls. Proves the canonical AgentJob path:
 * request → capture artifact → 5 AgentJobs → gateway (ModelRouter, fallback, validation) → runs,
 * execution logs, artifacts → A06 after upstream → synthesis → attention/next-step, with the
 * production pipeline untouched.
 */
import { describe, expect, it } from "vitest";
import { reduceOS, type OSAction } from "@/state/os-store";
import { runAuditPipeline, AUDIT_PHASES, executionContextFor, type CaptureResult } from "@/services/audit-orchestrator";
import { deriveAuditSteps } from "@/services/audit-progress";
import { deriveAttentionQueue } from "@/services/attention-queue";
import { resolveNextStep } from "@/services/next-step";
import { digestPage, type SiteCapture } from "@/services/site-digest";
import { EmbeddedGatewayClient, type ExecuteOptions, type GatewayClient } from "@/gateway/client";
import { handleExecute, type GatewayResponse } from "@/gateway/core";
import { OSDataGatewayStore } from "@/gateway/store";
import { ModelRouter } from "@/ai/router";
import { ProviderRegistry } from "@/ai/registry";
import { StubProvider } from "@/ai/providers/stub";
import { validateOutput } from "@/schemas/artifacts";
import { AGENT_IDS } from "@/data/seed";
import type { OSData } from "@/data/types";
import { base, lead, ROLES_BY_ID } from "./fixtures";

const HTML = `<html><head><title>Acme Widgets</title><meta name="description" content="Widgets for professionals, delivered nationwide."></head><body><nav><a href="/about">About</a><a href="/services">Services</a></nav><h1>Widgets for professionals</h1><a class="btn" href="/quote">Get a quote</a><footer><a href="tel:+27110000000">Call</a></footer></body></html>`;

const CAPTURE: SiteCapture = { targetUrl: "https://acme.example", capturedAt: "2026-01-01T00:00:00.000Z", pages: [digestPage("https://acme.example", HTML, 200)], skippedUrls: [{ url: "https://acme.example/about", reason: "HTTP 404" }], screenshots: [] };
const captureOk = async (): Promise<CaptureResult> => ({ ok: true, capture: CAPTURE });

const stubs = (opts: Partial<Record<"claude" | "openai" | "gemini", Omit<ConstructorParameters<typeof StubProvider>[0], "id">>> = {}) =>
  new ProviderRegistry([new StubProvider({ id: "claude", ...opts.claude }), new StubProvider({ id: "openai", ...opts.openai }), new StubProvider({ id: "gemini", ...opts.gemini })]);

/** Harness: local snapshot advanced through the real reducer, like OSStoreInner.startAudit. */
function harness(initial: OSData, gateway: GatewayClient, extra: Partial<Parameters<typeof runAuditPipeline>[0]> = {}) {
  let snapshot = reduceOS(initial, { type: "CREATE_AUDIT_REQUEST", requestId: "audit_1", targetUrl: "https://acme.example", auditType: "PUBLIC_PROSPECT", projectId: "proj_uproof", actor: lead });
  const applied: OSAction[] = [];
  let n = 0;
  const run = () =>
    runAuditPipeline({
      requestId: "audit_1",
      user: lead,
      apply: (a) => { applied.push(a); snapshot = reduceOS(snapshot, a); return snapshot; },
      snapshot: () => snapshot,
      gateway,
      capture: captureOk,
      newId: (p) => `${p}_${++n}`,
      ...extra,
    });
  return { run, get data() { return snapshot; }, applied };
}

const embedded = (registry = stubs()) => new EmbeddedGatewayClient({ getData: () => { throw new Error("must use posted context"); }, getUser: () => lead, registry });

/** A gateway that picks a provider registry per agent — lets one specialist fail while others succeed. */
function perAgentGateway(pick: (agentId: string) => ProviderRegistry): GatewayClient {
  return {
    kind: "embedded",
    async execute(jobId: string, opts: ExecuteOptions = {}) {
      const ctx = opts.context!;
      const job = ctx.data.agentJobs.find((j) => j.id === jobId)!;
      const store = new OSDataGatewayStore(ctx.data, ROLES_BY_ID);
      return handleExecute({ token: "t", jobId, artifactTitle: opts.artifactTitle }, { auth: { verify: async (t) => (t === "t" ? lead : null) }, store, router: new ModelRouter({ registry: pick(job.agentId) }), mode: "local" });
    },
    async health() { return { ok: false, code: "internal", message: "n/a", status: 500 }; },
  };
}

const jobOf = (d: OSData, agentId: string) => d.agentJobs.find((j) => d.websiteAuditRequests[0].auditJobIds.includes(j.id) && j.agentId === agentId)!;
const request = (d: OSData) => d.websiteAuditRequests.find((r) => r.id === "audit_1")!;

describe("audit orchestration — canonical AgentJob path", () => {
  it("runs capture → A01 → A02 → A03‖A04 → A06 → synthesis through the gateway core and settles COMPLETE", async () => {
    const before = base();
    const ticketsBefore = JSON.stringify(before.tickets);
    const jobsBefore = before.agentJobs.length;
    const h = harness(before, embedded());
    const summary = await h.run();
    const d = h.data;
    const req = request(d);

    // request persisted and settled
    expect(summary.status).toBe("COMPLETE");
    expect(req.status).toBe("COMPLETE");
    expect(req.resultArtifactId).toBeTruthy();
    expect(req.progressLog.join("\n")).toMatch(/Capture evidence stored/);

    // capture is an artifact, never raw HTML
    const capture = d.artifacts.find((a) => a.type === "audit_capture")!;
    expect(capture.status).toBe("FINAL");
    expect(JSON.stringify(capture.content)).not.toMatch(/<html|<h1/);

    // exactly five canonical AgentJobs with the right identities, all in the store, all COMPLETED
    expect(req.auditJobIds).toHaveLength(5);
    expect(d.agentJobs.length).toBe(jobsBefore + 5);
    const agentIds = req.auditJobIds.map((id) => d.agentJobs.find((j) => j.id === id)!.agentId);
    expect(agentIds).toEqual([AGENT_IDS.A01, AGENT_IDS.A02, AGENT_IDS.A03, AGENT_IDS.A04, AGENT_IDS.A06]);
    for (const id of req.auditJobIds) {
      const job = d.agentJobs.find((j) => j.id === id)!;
      expect(job.status).toBe("COMPLETED");
      expect(job.ticketId).toBeUndefined();
      expect(job.projectId).toBe("proj_uproof");
      expect(job.outputArtifactId).toBeTruthy();
      expect(d.artifacts.find((a) => a.id === job.outputArtifactId)?.status).toBe("FINAL");
      // Runs page + execution logs see every job
      expect(d.agentRuns.some((r) => r.jobId === id && r.status === "SUCCEEDED")).toBe(true);
      expect(d.executionLogs.some((l) => l.jobId === id && l.status === "COMPLETED")).toBe(true);
    }

    // A02 consumed capture + A01 output; A06 consumed everything upstream and started after A04 finished
    const a01 = jobOf(d, AGENT_IDS.A01);
    const a02 = jobOf(d, AGENT_IDS.A02);
    const a04 = jobOf(d, AGENT_IDS.A04);
    const a06 = jobOf(d, AGENT_IDS.A06);
    expect(a02.inputArtifactIds).toEqual([capture.id, a01.outputArtifactId]);
    expect(a06.inputArtifactIds).toEqual([capture.id, a01.outputArtifactId, a02.outputArtifactId, jobOf(d, AGENT_IDS.A03).outputArtifactId, a04.outputArtifactId]);
    expect(a06.startedAt! >= a04.completedAt!).toBe(true);
    expect(d.artifacts.find((a) => a.id === a01.outputArtifactId)?.type).toBe("audit_discovery");
    expect(d.artifacts.find((a) => a.id === a06.outputArtifactId)?.type).toBe("audit_qa_review");

    // A01's seeded policy prefers Gemini: the router recorded the real winning attempt with provenance, identity preserved
    const a01Runs = d.agentRuns.filter((r) => r.jobId === a01.id);
    const a01Policy = d.agents.find((a) => a.id === AGENT_IDS.A01)!.providerPolicy;
    expect(a01Runs.find((r) => r.status === "SUCCEEDED")?.providerId).toBe(a01Policy.preferred);
    expect(a01Runs.every((r) => r.agentId === AGENT_IDS.A01 && r.status !== "FAILED")).toBe(true);
    expect(d.artifacts.find((a) => a.id === a01.outputArtifactId)?.createdByProvider).toBe(a01Policy.preferred);

    // synthesis: valid report from normalised agent findings + labelled heuristics
    const report = d.artifacts.find((a) => a.id === req.resultArtifactId)!;
    expect(report.type).toBe("website_audit_report");
    expect(validateOutput("website_audit_report@1", report.content).ok).toBe(true);
    const content = report.content as { completionStatus: string; findings: Array<{ id: string; agentId: string | null }>; agentOutcomes: Array<{ status: string; providerId: string | null }>; visualVerificationStatus: string; evidenceGaps: string[]; rawFindingCount: number; consolidatedFindingCount: number; coverage: Record<string, unknown> };
    expect(content.completionStatus).toBe("COMPLETE");
    expect(content.agentOutcomes.map((o) => o.status)).toEqual(["COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED"]);
    expect(content.visualVerificationStatus).toBe("VISUAL_NOT_VERIFIED");
    expect(content.evidenceGaps.join(" ")).toMatch(/about \(HTTP 404\)/);
    const rows = d.auditFindings.filter((f) => f.auditRequestId === "audit_1");
    const rawRows = rows.filter((f) => f.kind === "RAW");
    const findings = rows.filter((f) => f.kind === "CONSOLIDATED");
    expect(rawRows.filter((f) => f.agentId === AGENT_IDS.A02)).toHaveLength(1);
    expect(rawRows.filter((f) => f.agentId === AGENT_IDS.A03)).toHaveLength(1);
    expect(rawRows.filter((f) => f.agentId === AGENT_IDS.A04)).toHaveLength(1);
    expect(rawRows.filter((f) => f.agentId === null).every((f) => /HEURISTIC/.test(f.evidence))).toBe(true);
    // A06 confirmed "content-weak-h1" in the stub example → annotated, not dropped, and it survives consolidation
    expect(rawRows.find((f) => f.agentId === AGENT_IDS.A04)?.qaStatus).toBe("CONFIRMED");
    expect(findings.find((f) => f.sourceFindingIds?.includes(rawRows.find((f) => f.agentId === AGENT_IDS.A04)!.id))?.qaStatus).toBe("CONFIRMED");
    // Report and UI use the SAME consolidated rows; raw count is disclosed separately and is never smaller
    expect(content.findings.map((f) => f.id).sort()).toEqual(findings.map((f) => f.id).sort());
    expect(content.consolidatedFindingCount).toBe(findings.length);
    expect(content.rawFindingCount).toBe(rawRows.length);
    expect(rawRows.length).toBeGreaterThanOrEqual(findings.length);
    expect(summary.findings).toBe(findings.length);
    expect(d.activity.at(-1)?.message).toMatch(new RegExp(`${findings.length} finding\\(s\\)`));
    expect(content.coverage).toMatchObject({ pagesCaptured: 1, pagesSkipped: 1, partial: true });

    // agents returned to IDLE with outputs counted; production tickets untouched
    for (const id of [AGENT_IDS.A01, AGENT_IDS.A02, AGENT_IDS.A03, AGENT_IDS.A04, AGENT_IDS.A06]) expect(d.agents.find((a) => a.id === id)?.status).toBe("IDLE");
    expect(JSON.stringify(d.tickets)).toBe(ticketsBefore);
    expect(d.agentJobs.filter((j) => j.ticketId).length).toBe(before.agentJobs.filter((j) => j.ticketId).length);

    // progress, attention queue and next step derive from the same records
    const steps = deriveAuditSteps(d, req);
    expect(steps.map((s) => `${s.key}:${s.state}`)).toEqual(["capture:COMPLETE", "agent_01:COMPLETE", "agent_02:COMPLETE", "agent_03:COMPLETE", "agent_04:COMPLETE", "agent_06:COMPLETE", "synthesis:COMPLETE"]);
    expect(steps[1].detail).toMatch(/Gemini/);
    expect(deriveAttentionQueue(d).some((i) => i.kind === "audit_complete" && i.sourceIds.includes("audit_1"))).toBe(true);
    // Seeded U-Proof carries open launch holds, which rightly outrank the audit prompt — clear them to see it.
    const noHolds = (x: OSData): OSData => ({ ...x, launchHolds: x.launchHolds.map((h) => ({ ...h, resolved: true })) });
    const next = resolveNextStep(noHolds(d), "proj_uproof");
    expect(next.outcome).toBe("HUMAN_ACTION");
    expect(next.action).toMatch(/Review audit findings/);
    const reviewed = reduceOS(d, { type: "AUDIT_REVIEWED", requestId: "audit_1", actor: lead });
    expect(deriveAttentionQueue(reviewed).some((i) => i.sourceIds.includes("audit_1"))).toBe(false);
    expect(resolveNextStep(noHolds(reviewed), "proj_uproof").action).not.toMatch(/Review audit findings/);
  });

  it("shows A01 WORKING on the Agents view and RUNNING on the Runs view while it executes", async () => {
    const seen: string[] = [];
    const spy: GatewayClient = {
      kind: "embedded",
      async execute(jobId, opts) {
        const d = opts!.context!.data;
        const job = d.agentJobs.find((j) => j.id === jobId)!;
        if (job.agentId === AGENT_IDS.A01) {
          // What the UI would read from the store at this moment
          const live = h.data;
          seen.push(`agent:${live.agents.find((a) => a.id === AGENT_IDS.A01)?.status}:${live.agents.find((a) => a.id === AGENT_IDS.A01)?.statusDetail}`);
          seen.push(`job:${live.agentJobs.find((j) => j.id === jobId)?.status}`);
          seen.push(`steps:${deriveAuditSteps(live, live.websiteAuditRequests[0]).map((s) => s.state).join(",")}`);
        }
        return embedded().execute(jobId, opts);
      },
      async health() { return { ok: false, code: "internal", message: "n/a", status: 500 }; },
    };
    const h = harness(base(), spy);
    await h.run();
    expect(seen).toEqual(["agent:WORKING:Audit acme.example", "job:RUNNING", "steps:COMPLETE,RUNNING,QUEUED,QUEUED,QUEUED,QUEUED,QUEUED"]);
  });

  it("one specialist failing after all fallbacks → PARTIAL; identity preserved; downstream still runs on what exists", async () => {
    const failing = stubs({ claude: { failWith: "claude down" }, openai: { failWith: "openai down" }, gemini: { failWith: "gemini down" } });
    const h = harness(base(), perAgentGateway((agentId) => (agentId === AGENT_IDS.A02 ? failing : stubs())));
    const summary = await h.run();
    const d = h.data;
    expect(summary.status).toBe("PARTIAL");
    expect(request(d).status).toBe("PARTIAL");
    const a02 = jobOf(d, AGENT_IDS.A02);
    // Every provider in A02's policy was tried and recorded; the job ends FAILED (or NEEDS_A_HAND once
    // MAX_AUTO_RETRY_ATTEMPTS is reached) — never silently replaced by another agent or a generic call.
    expect(["FAILED", "NEEDS_A_HAND"]).toContain(a02.status);
    expect(a02.agentId).toBe(AGENT_IDS.A02);
    const a02Policy = d.agents.find((a) => a.id === AGENT_IDS.A02)!.providerPolicy;
    const a02Runs = d.agentRuns.filter((r) => r.jobId === a02.id);
    expect(a02Runs.map((r) => r.providerId).sort()).toEqual([a02Policy.preferred, ...a02Policy.fallbacks].sort());
    expect(a02Runs.every((r) => r.status === "FAILED" || r.status === "SKIPPED")).toBe(true);
    expect(a02Runs.some((r) => r.status === "FAILED")).toBe(true);
    expect(a02.error).toBeTruthy();
    // A03/A04 consumed capture + A01 only (no A02 output exists); A06 still reviewed the rest
    const a01 = jobOf(d, AGENT_IDS.A01);
    expect(jobOf(d, AGENT_IDS.A03).inputArtifactIds).toEqual([d.artifacts.find((a) => a.type === "audit_capture")!.id, a01.outputArtifactId]);
    expect(jobOf(d, AGENT_IDS.A06).status).toBe("COMPLETED");
    const content = d.artifacts.find((a) => a.id === request(d).resultArtifactId)!.content as { completionStatus: string; evidenceGaps: string[] };
    expect(content.completionStatus).toBe("PARTIAL");
    expect(content.evidenceGaps.join(" ")).toMatch(/agent_02 did not complete/);
    expect(d.auditFindings.some((f) => f.agentId === AGENT_IDS.A02 || f.contributors?.includes(AGENT_IDS.A02))).toBe(false);
    // attention queue flags the partial audit; the audit job never blocks the production Next Step
    expect(deriveAttentionQueue(d).some((i) => i.kind === "audit_failed" && i.sourceIds.includes(a02.id))).toBe(true);
    expect(deriveAttentionQueue(d).some((i) => i.kind === "needs_a_hand" && i.sourceIds.includes(a02.id))).toBe(false);
    expect(resolveNextStep(d, "proj_uproof").blocker ?? "").not.toMatch(/NEEDS_A_HAND/);
    const steps = deriveAuditSteps(d, request(d)).map((s) => s.state);
    expect(steps[2]).toBe(a02.status === "FAILED" ? "FAILED" : "NEEDS_A_HAND");
    expect([steps[0], steps[1], steps[3], steps[4], steps[5], steps[6]]).toEqual(["COMPLETE", "COMPLETE", "COMPLETE", "COMPLETE", "COMPLETE", "PARTIAL"]);
  });

  it("malformed provider output is rejected by validation and never becomes findings", async () => {
    const invalid = stubs({ claude: { invalidOutput: true }, openai: { invalidOutput: true }, gemini: { invalidOutput: true } });
    const h = harness(base(), perAgentGateway((agentId) => (agentId === AGENT_IDS.A04 ? invalid : stubs())));
    await h.run();
    const d = h.data;
    const a04 = jobOf(d, AGENT_IDS.A04);
    expect(["FAILED", "NEEDS_A_HAND"]).toContain(a04.status);
    expect(a04.outputArtifactId).toBeNull();
    const a04Runs = d.agentRuns.filter((r) => r.jobId === a04.id);
    expect(a04Runs.some((r) => r.status === "FAILED_VALIDATION")).toBe(true);
    expect(a04Runs.every((r) => r.status === "FAILED_VALIDATION" || r.status === "SKIPPED")).toBe(true);
    expect(a04Runs.find((r) => r.status === "FAILED_VALIDATION")?.validation?.ok).toBe(false);
    expect(d.auditFindings.some((f) => f.agentId === AGENT_IDS.A04 || f.contributors?.includes(AGENT_IDS.A04))).toBe(false);
    expect(request(d).status).toBe("PARTIAL");
  });

  it("every specialist failing → NEEDS_A_HAND with a HEURISTIC_ONLY report and A06 cancelled", async () => {
    const h = harness(base(), embedded(stubs({ claude: { failWith: "x" }, openai: { failWith: "x" }, gemini: { failWith: "x" } })));
    const summary = await h.run();
    const d = h.data;
    expect(summary.status).toBe("NEEDS_A_HAND");
    expect(jobOf(d, AGENT_IDS.A06).status).toBe("CANCELLED");
    const content = d.artifacts.find((a) => a.id === request(d).resultArtifactId)!.content as { completionStatus: string; findings: Array<{ agentId: string | null }> };
    expect(content.completionStatus).toBe("HEURISTIC_ONLY");
    expect(content.findings.every((f) => f.agentId === null)).toBe(true);
    expect(request(d).failureReason).toMatch(/heuristic-only/);
  });

  it("capture failure → FAILED with no specialist jobs created", async () => {
    const h = harness(base(), embedded(), { capture: async () => ({ ok: false, error: "Private network addresses are not allowed" }) });
    const summary = await h.run();
    expect(summary.status).toBe("FAILED");
    expect(request(h.data).status).toBe("FAILED");
    expect(request(h.data).failureReason).toMatch(/Private network/);
    expect(request(h.data).auditJobIds).toHaveLength(0);
    expect(deriveAttentionQueue(h.data).some((i) => i.kind === "audit_failed")).toBe(true);
  });

  it("an unreachable primary gateway falls back to the embedded gateway and says so", async () => {
    const dead: GatewayClient = { kind: "http", async execute() { return { ok: false, code: "internal", message: "Gateway returned 503", status: 503 } as GatewayResponse; }, async health() { return { ok: false, code: "internal", message: "n/a", status: 503 }; } };
    const h = harness(base(), dead, { fallbackGateway: embedded() });
    const summary = await h.run();
    expect(summary.status).toBe("COMPLETE");
    expect(request(h.data).progressLog.join("\n")).toMatch(/embedded gateway/);
  });

  it("executionContextFor posts only what the gateway needs: this job, its agent, its inputs, approved knowledge", () => {
    const d = base();
    const job = { ...d.agentJobs[0], id: "j", inputArtifactIds: [d.artifacts[0].id] };
    const ctx = executionContextFor({ ...d, agentJobs: [job] }, job, lead);
    expect(ctx.data.agentJobs).toEqual([job]);
    expect(ctx.data.artifacts.map((a) => a.id)).toEqual([d.artifacts[0].id]);
    expect(ctx.data.knowledgeItems.every((k) => k.status === "APPROVED")).toBe(true);
    expect(ctx.data.tickets).toHaveLength(0);
    expect(ctx.user).toBe(lead);
  });

  it("phase definitions: five specialists, A06 last, A05/A07/A08 never involved", () => {
    expect(AUDIT_PHASES.map((p) => p.agentId)).toEqual([AGENT_IDS.A01, AGENT_IDS.A02, AGENT_IDS.A03, AGENT_IDS.A04, AGENT_IDS.A06]);
    expect(AUDIT_PHASES.find((p) => p.phase === "A03")!.instructions).toMatch(/VISUAL_NOT_VERIFIED/);
    expect(AUDIT_PHASES.find((p) => p.phase === "A06")!.instructions).toMatch(/checkout, form submission, analytics, mobile rendering/);
  });
});

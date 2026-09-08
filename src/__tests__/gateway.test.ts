/**
 * Execution gateway — identity, permission enforcement, validation, fallback, logging.
 * Runs the same core the Edge Function and dev middleware run, over an OSData-backed store.
 */
import { describe, expect, it } from "vitest";
import type { AuthUser, OSData } from "@/data/types";
import { ModelRouter } from "@/ai/router";
import { ProviderRegistry } from "@/ai/registry";
import { StubProvider } from "@/ai/providers/stub";
import { handleExecute, handleHealth, type GatewayDeps } from "@/gateway/core";
import { OSDataGatewayStore } from "@/gateway/store";
import { createJob, createJobForTicket } from "@/services/agent-jobs";
import { authorizeRedJob, decideJobApproval, requestJobApproval, actionFingerprint } from "@/services/job-approvals";
import { admin, base, lead, member, ROLES_BY_ID, viewer } from "./fixtures";

const users: Record<string, AuthUser> = { [lead.id]: lead, [admin.id]: admin, [member.id]: member, [viewer.id]: viewer };

function deps(data: OSData, providers: StubProvider[] = [new StubProvider({ id: "claude" }), new StubProvider({ id: "openai" }), new StubProvider({ id: "gemini" })]): GatewayDeps & { store: OSDataGatewayStore; events: Record<string, unknown>[] } {
  const store = new OSDataGatewayStore(data, ROLES_BY_ID);
  const events: Record<string, unknown>[] = [];
  return {
    auth: { verify: async (token) => (token && token.startsWith("tok:") ? (users[token.slice(4)] ?? null) : null) },
    store,
    router: new ModelRouter({ registry: new ProviderRegistry(providers) }),
    mode: "local",
    log: (e) => events.push(e),
    events,
  };
}

/** A GREEN job for Agent 08 (Intelligence Curator) on U-Proof — the safe end-to-end test job (Part L). */
function greenJob(d: OSData = base()) {
  return createJob(d, {
    projectId: "proj_uproof",
    agentId: "agent_08",
    instructions: "Review the existing U-Proof lesson candidates and return a structured lesson_candidate artifact summarizing one reusable QA lesson.",
    inputArtifactIds: ["art_up_qa", "art_up_regression"],
    requestedById: lead.id,
    id: "job_green",
  });
}

/** An AMBER job: Agent 05 builder ticket on U-Proof. */
function amberJob(d: OSData = base()) {
  const ticket = d.tickets.find((t) => t.code === "CT-UP-020")!;
  return createJobForTicket(d, ticket, { id: "job_amber", requestedById: member.id });
}

/** A RED job: same builder agent but with the agent's tier raised to RED (e.g. production activation). */
function redJob(d: OSData = base()) {
  const raised = { ...d, agents: d.agents.map((a) => (a.id === "agent_07" ? { ...a, permissionLevel: "RED" as const } : a)) };
  return createJob(raised, { projectId: "proj_uproof", agentId: "agent_07", instructions: "Activate the production site (RED).", id: "job_red", requestedById: lead.id });
}

describe("gateway — auth/session guard", () => {
  it("rejects a missing or invalid session before touching the job", async () => {
    const { data } = greenJob();
    const d = deps(data);
    expect(await handleExecute({ token: null, jobId: "job_green" }, d)).toMatchObject({ ok: false, code: "unauthenticated", status: 401 });
    expect(await handleExecute({ token: "tok:nobody", jobId: "job_green" }, d)).toMatchObject({ ok: false, code: "unauthenticated", status: 401 });
    expect(await handleHealth({ token: "garbage" }, d)).toMatchObject({ ok: false, status: 401 });
    expect(d.store.data.agentJobs.find((j) => j.id === "job_green")?.status).toBe("QUEUED");
    expect(d.store.data.executionLogs.length).toBe(0);
  });

  it("health reports provider states for a signed-in user without any secret", async () => {
    const { data } = greenJob();
    const res = await handleHealth({ token: `tok:${viewer.id}` }, deps(data));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.providers.map((p) => `${p.id}:${p.state}`)).toEqual(["claude:stub", "openai:stub", "gemini:stub"]);
      // Env var NAMES are allowed (they tell the operator what to set); values never are.
      expect(JSON.stringify(res)).not.toMatch(/sk-[A-Za-z0-9]|Bearer |service_role/);
      expect(res.providers.find((p) => p.id === "openai")?.envVar).toBe("OPENAI_API_KEY");
    }
  });

  it("a VIEWER cannot execute even a GREEN job", async () => {
    const { data } = greenJob();
    const d = deps(data);
    const res = await handleExecute({ token: `tok:${viewer.id}`, jobId: "job_green" }, d);
    expect(res).toMatchObject({ ok: false, code: "forbidden", status: 403 });
    expect(d.store.data.executionLogs.at(-1)).toMatchObject({ status: "REJECTED", errorCategory: "permission_denied", permissionCheck: { level: "GREEN", outcome: "denied" } });
  });
});

describe("gateway — permission enforcement", () => {
  it("GREEN: executes automatically for a team member — job → permission → provider → validation → run → artifact → log", async () => {
    const { data } = greenJob();
    const d = deps(data);
    const res = await handleExecute({ token: `tok:${member.id}`, jobId: "job_green", artifactTitle: "U-Proof lesson summary" }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.permission).toMatchObject({ level: "GREEN", outcome: "allowed" });
    expect(res.result.status).toBe("COMPLETED");
    expect(res.result.outputSchema).toBe("lesson_candidate@1");
    expect(res.result.provider).toBe("claude"); // A08 prefers Claude
    // A08 needs long_context; the OpenAI stub lacks it and is skipped explicitly — never silently.
    expect(res.records.runs.map((r) => `${r.providerId}:${r.status}`)).toEqual(["claude:SUCCEEDED", "openai:SKIPPED"]);
    expect(res.records.runs[1].error).toMatch(/missing capability: long_context/);
    expect(res.records.artifact).toMatchObject({ type: "lesson_candidate", title: "U-Proof lesson summary", status: "DRAFT", createdByAgentId: "agent_08", createdByProvider: "claude", version: 1 });
    expect(res.records.job.status).toBe("WAITING_APPROVAL");
    expect(res.records.job.outputArtifactId).toBe(res.records.artifact?.id);
    expect(res.records.logs).toHaveLength(2);
    expect(res.records.logs[0]).toMatchObject({ status: "COMPLETED", artifactId: res.records.artifact?.id, permissionCheck: { level: "GREEN", outcome: "allowed" }, validation: { ok: true }, requestedById: member.id });
    // Committed server-side
    expect(d.store.data.agentJobs.find((j) => j.id === "job_green")?.status).toBe("WAITING_APPROVAL");
    expect(d.store.data.artifacts.some((a) => a.id === res.records.artifact?.id)).toBe(true);
    expect(d.events.map((e) => e.event)).toEqual(["execute.start", "execute.completed"]);
  });

  it("AMBER: rejected without an approval record; the job is untouched and the denial is logged", async () => {
    const { data } = amberJob();
    const d = deps(data);
    const res = await handleExecute({ token: `tok:${member.id}`, jobId: "job_amber" }, d);
    expect(res).toMatchObject({ ok: false, code: "forbidden", status: 403 });
    expect((res as { permission?: { reason: string } }).permission?.reason).toMatch(/AMBER — no approval record/);
    expect(d.store.data.agentJobs.find((j) => j.id === "job_amber")?.status).toBe("QUEUED");
    expect(d.store.data.agentRuns.length).toBe(0);
    expect(d.store.data.executionLogs.at(-1)).toMatchObject({ status: "REJECTED", permissionCheck: { level: "AMBER", outcome: "denied" } });
  });

  it("AMBER: a PENDING request is still rejected; only an APPROVED record by a lead/admin allows execution, and it is consumed", async () => {
    let { data, job } = amberJob();
    const agentName = "05 WordPress / Elementor Builder";
    const requested = requestJobApproval(data, job, member, agentName);
    data = requested.data;
    expect((await handleExecute({ token: `tok:${member.id}`, jobId: "job_amber" }, deps(data))).ok).toBe(false);

    // A team member cannot approve.
    expect(() => decideJobApproval(data, requested.approval.id, "APPROVED", member)).toThrow(/cannot approve/);
    data = decideJobApproval(data, requested.approval.id, "APPROVED", lead).data;
    const d = deps(data);
    const res = await handleExecute({ token: `tok:${member.id}`, jobId: "job_amber" }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.permission).toMatchObject({ level: "AMBER", outcome: "allowed", approvalId: requested.approval.id });
    expect(res.records.approval?.status).toBe("CONSUMED");
    expect(d.store.data.jobApprovals.find((a) => a.id === requested.approval.id)?.status).toBe("CONSUMED");
    // Consumed → a second execution needs a fresh approval.
    const again = deps({ ...d.store.data, agentJobs: d.store.data.agentJobs.map((j) => (j.id === "job_amber" ? { ...j, status: "QUEUED" as const } : j)) });
    expect((await handleExecute({ token: `tok:${member.id}`, jobId: "job_amber" }, again)).ok).toBe(false);
  });

  it("AMBER: an approval does not survive a change to the action (fingerprint mismatch)", async () => {
    let { data, job } = amberJob();
    const r = requestJobApproval(data, job, member, "05 Builder");
    data = decideJobApproval(r.data, r.approval.id, "APPROVED", lead).data;
    // Instructions edited after approval.
    data = { ...data, agentJobs: data.agentJobs.map((j) => (j.id === "job_amber" ? { ...j, instructions: `${j.instructions}\nAlso delete the old theme.` } : j)) };
    const res = await handleExecute({ token: `tok:${member.id}`, jobId: "job_amber" }, deps(data));
    expect(res.ok).toBe(false);
    expect((res as { permission?: { reason: string } }).permission?.reason).toMatch(/action changed/);
    expect(actionFingerprint(data.agentJobs.find((j) => j.id === "job_amber")!)).not.toBe(r.approval.actionFingerprint);
  });

  it("AMBER: the approver's role is re-verified server-side, not trusted from the record", async () => {
    let { data, job } = amberJob();
    const r = requestJobApproval(data, job, member, "05 Builder");
    // Forged record: claims approval by the team member with a fake role.
    data = { ...r.data, jobApprovals: r.data.jobApprovals.map((a) => (a.id === r.approval.id ? { ...a, status: "APPROVED" as const, approvedById: member.id, approvedByName: member.displayName, approvedByRole: "ADMIN" as const } : a)) };
    const res = await handleExecute({ token: `tok:${member.id}`, jobId: "job_amber" }, deps(data));
    expect(res.ok).toBe(false);
    expect((res as { permission?: { reason: string } }).permission?.reason).toMatch(/approver is not a Production Lead or Admin/);
  });

  it("RED: rejected without explicit authorization by the current user; another lead's authorization does not count", async () => {
    let { data, job } = redJob();
    expect((await handleExecute({ token: `tok:${lead.id}`, jobId: "job_red" }, deps(data))).ok).toBe(false);
    // Admin authorizes for themselves — the lead still cannot run it.
    data = authorizeRedJob(data, job, admin, "07 Infrastructure").data;
    const res = await handleExecute({ token: `tok:${lead.id}`, jobId: "job_red" }, deps(data));
    expect(res.ok).toBe(false);
    expect((res as { permission?: { reason: string } }).permission?.reason).toMatch(/RED — no explicit authorization by the current user/);
    // The admin who authorized can run it.
    const ok = await handleExecute({ token: `tok:${admin.id}`, jobId: "job_red" }, deps(data));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.permission).toMatchObject({ level: "RED", outcome: "allowed" });
  });

  it("RED: a team member can neither authorize nor run", async () => {
    const { data, job } = redJob();
    expect(() => authorizeRedJob(data, job, member, "07")).toThrow(/cannot authorize/);
    expect((await handleExecute({ token: `tok:${member.id}`, jobId: "job_red" }, deps(data))).ok).toBe(false);
  });

  it("uses the agent's CURRENT tier when it is higher than the tier recorded on the job", async () => {
    let { data } = greenJob();
    data = { ...data, agents: data.agents.map((a) => (a.id === "agent_08" ? { ...a, permissionLevel: "AMBER" as const } : a)) };
    const res = await handleExecute({ token: `tok:${lead.id}`, jobId: "job_green" }, deps(data));
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
    expect((res as { permission?: { level: string } }).permission?.level).toBe("AMBER");
  });

  it("refuses jobs that are not QUEUED/RUNNING and unknown jobs", async () => {
    const { data } = greenJob();
    const done = { ...data, agentJobs: data.agentJobs.map((j) => (j.id === "job_green" ? { ...j, status: "COMPLETED" as const } : j)) };
    expect(await handleExecute({ token: `tok:${lead.id}`, jobId: "job_green" }, deps(done))).toMatchObject({ ok: false, code: "invalid_state", status: 409 });
    expect(await handleExecute({ token: `tok:${lead.id}`, jobId: "nope" }, deps(data))).toMatchObject({ ok: false, code: "not_found", status: 404 });
  });
});

describe("gateway — structured validation and fallback", () => {
  it("a provider whose output fails validation is recorded as FAILED_VALIDATION and the next provider is tried", async () => {
    const { data } = greenJob(); // A08: claude → gemini → openai
    const d = deps(data, [new StubProvider({ id: "claude", invalidOutput: true }), new StubProvider({ id: "gemini" }), new StubProvider({ id: "openai" })]);
    const res = await handleExecute({ token: `tok:${lead.id}`, jobId: "job_green" }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.status).toBe("COMPLETED");
    expect(res.result.provider).toBe("gemini");
    expect(res.records.runs.map((r) => `${r.providerId}:${r.status}`)).toEqual(["claude:FAILED_VALIDATION", "gemini:SUCCEEDED", "openai:SKIPPED"]);
    const failed = res.records.runs[0];
    expect(failed.validation?.ok).toBe(false);
    expect(failed.validation?.issues.length).toBeGreaterThan(0);
    expect(failed.error).toMatch(/failed lesson_candidate@1 validation/);
    // Raw output is preserved in the execution log for the failed attempt only.
    const logs = res.records.logs;
    expect(logs[0]).toMatchObject({ status: "FAILED_VALIDATION", providerId: "claude", errorCategory: "validation" });
    expect(logs[0].rawOutput).toMatchObject({ stub: true });
    expect(logs[1]).toMatchObject({ status: "COMPLETED", providerId: "gemini", rawOutput: null });
    // The artifact came from the validated provider, never the invalid one.
    expect(res.records.artifact?.createdByProvider).toBe("gemini");
  });

  it("when every provider fails validation the job is FAILED_VALIDATION with actionable issues and no artifact", async () => {
    const { data } = greenJob();
    const d = deps(data, [new StubProvider({ id: "claude", invalidOutput: true }), new StubProvider({ id: "gemini", invalidOutput: true }), new StubProvider({ id: "openai", invalidOutput: true })]);
    const res = await handleExecute({ token: `tok:${lead.id}`, jobId: "job_green" }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.status).toBe("FAILED_VALIDATION");
    expect(res.result.error?.category).toBe("validation");
    expect(res.result.error?.issues?.[0]).toMatchObject({ path: expect.any(String), message: expect.any(String) });
    expect(res.records.artifact).toBeNull();
    expect(res.records.job.status).toBe("FAILED");
    expect(d.store.data.artifacts.filter((a) => a.jobId === "job_green").length).toBe(0);
    expect(res.records.runs.filter((r) => r.status !== "SKIPPED").every((r) => r.status === "FAILED_VALIDATION")).toBe(true);
  });

  it("provider errors and unavailability fall through in policy order and are all recorded", async () => {
    const { data } = greenJob();
    const full = new StubProvider({ id: "openai", capabilities: ["text", "structured_output", "long_context", "vision", "code", "review"] });
    const d = deps(data, [new StubProvider({ id: "claude", failWith: "rate limited" }), new StubProvider({ id: "gemini", available: false, unavailableReason: "not configured (GEMINI_API_KEY)" }), full]);
    const res = await handleExecute({ token: `tok:${lead.id}`, jobId: "job_green" }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.provider).toBe("openai");
    expect(res.result.attempts.map((a) => `${a.providerId}:${a.outcome}`)).toEqual(["claude:failed", "gemini:skipped", "openai:succeeded"]);
    expect(res.records.logs.map((l) => `${l.fallbackIndex}:${l.status}`)).toEqual(["0:FAILED", "1:SKIPPED", "2:COMPLETED"]);
  });
});

describe("gateway — agent continuity", () => {
  it("Agent 02 remains Agent 02 whichever provider executes: identity, knowledge, inputs, handoff and artifact lineage stay in CT-OS", async () => {
    const d0 = base();
    const ticket = d0.tickets.find((t) => t.code === "CT-UP-019")!;
    // Use a UX ticket shape on Agent 02 for the test.
    const uxTicket = { ...ticket, id: "t_ux", code: "CT-UP-UX", agentId: "agent_02", title: "UX blueprint" };
    const d1 = { ...d0, tickets: [...d0.tickets, uxTicket] };
    const { data, job } = createJobForTicket(d1, uxTicket, { id: "job_ux", requestedById: lead.id });
    expect(job.preferredProvider).toBe("claude");

    // Run 1: Claude available.
    const withClaude = deps(data, [new StubProvider({ id: "claude" }), new StubProvider({ id: "openai" })]);
    const r1 = await handleExecute({ token: `tok:${lead.id}`, jobId: "job_ux" }, withClaude);
    expect(r1.ok && r1.result.provider).toBe("claude");
    const claudeRequest = withClaude.router.providers().find((p) => p.id === "claude") as StubProvider;

    // Run 2: Claude unavailable → OpenAI executes the SAME agent's job (re-queued for the test).
    const requeued = { ...withClaude.store.data, agentJobs: withClaude.store.data.agentJobs.map((j) => (j.id === "job_ux" ? { ...j, status: "QUEUED" as const } : j)) };
    const withoutClaude = deps(requeued, [new StubProvider({ id: "claude", available: false, unavailableReason: "outage" }), new StubProvider({ id: "openai" })]);
    const r2 = await handleExecute({ token: `tok:${lead.id}`, jobId: "job_ux" }, withoutClaude);
    expect(r2.ok && r2.result.provider).toBe("openai");
    const openaiRequest = withoutClaude.router.providers().find((p) => p.id === "openai") as StubProvider;

    // Same agent identity and the same CT-OS context reached both providers.
    const a = claudeRequest.calls[0];
    const b = openaiRequest.calls[0];
    expect(a.agent).toEqual({ code: "02", name: "UX & Conversion Architect", role: "Sitemap, customer journey, IA, conversion logic", responsibilities: expect.any(Array) });
    expect(b.agent).toEqual(a.agent);
    expect(b.agentId).toBe("agent_02");
    expect(b.approvedKnowledge.doctrine.map((k) => k.id)).toEqual(a.approvedKnowledge.doctrine.map((k) => k.id));
    expect(b.inputArtifacts.map((x) => x.id)).toEqual(a.inputArtifacts.map((x) => x.id));
    expect(b.requiredOutputSchema).toBe("site_blueprint@1");
    expect(a.systemContext).not.toMatch(/Claude|OpenAI|Gemini/);

    // Artifact lineage and handoff belong to the agent, not the provider.
    if (r1.ok && r2.ok) {
      expect(r2.records.artifact?.version).toBe(2);
      expect(r2.records.artifact?.supersedesArtifactId).toBe(r1.records.artifact?.id);
      expect(r2.records.artifact?.createdByAgentId).toBe("agent_02");
      expect(r1.records.artifact?.createdByProvider).toBe("claude");
      expect(r2.records.artifact?.createdByProvider).toBe("openai");
      expect(r2.records.handoff?.destinationAgentId).toBe("agent_02");
      expect(r2.records.handoff?.id).toBe(r1.records.handoff?.id);
    }
    expect(withoutClaude.store.data.agentRuns.filter((r) => r.jobId === "job_ux").map((r) => `${r.providerId}:${r.status}`)).toEqual(["claude:SUCCEEDED", "claude:SKIPPED", "openai:SUCCEEDED"]);
  });
});

describe("gateway — run history", () => {
  it("run attempts number continuously across executions of the same job and carry latency/validation", async () => {
    const { data } = greenJob();
    const first = deps(data, [new StubProvider({ id: "claude", failWith: "boom" }), new StubProvider({ id: "gemini" })]);
    const r1 = await handleExecute({ token: `tok:${lead.id}`, jobId: "job_green" }, first);
    expect(r1.ok).toBe(true);
    const requeued = { ...first.store.data, agentJobs: first.store.data.agentJobs.map((j) => (j.id === "job_green" ? { ...j, status: "QUEUED" as const } : j)) };
    const second = deps(requeued, [new StubProvider({ id: "claude" })]);
    await handleExecute({ token: `tok:${lead.id}`, jobId: "job_green" }, second);
    const runs = second.store.data.agentRuns.filter((r) => r.jobId === "job_green");
    expect(runs.map((r) => r.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(runs.map((r) => `${r.providerId}:${r.status}`)).toEqual(["claude:FAILED", "gemini:SUCCEEDED", "openai:SKIPPED", "claude:SUCCEEDED", "gemini:SKIPPED", "openai:SKIPPED"]);
    for (const r of runs.filter((x) => x.status === "SUCCEEDED")) {
      expect(r.latencyMs).not.toBeNull();
      expect(r.validation?.ok).toBe(true);
      expect(r.startedAt && r.finishedAt).toBeTruthy();
    }
    expect(runs[0].errorCategory).toBe("provider_error");
    expect(runs[2].errorCategory).toBe("provider_unavailable");
  });
});

describe("gateway — review fixes (CTOS-002)", () => {
  it("concurrent executions of one job: the second is refused while the first holds the lease", async () => {
    const { data } = greenJob();
    const d = deps(data);
    const slow = new StubProvider({ id: "claude" });
    const origExecute = slow.execute.bind(slow);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    slow.execute = async (req) => {
      await gate;
      return origExecute(req);
    };
    const racing = { ...d, router: new ModelRouter({ registry: new ProviderRegistry([slow]) }) };
    const first = handleExecute({ token: `tok:${lead.id}`, jobId: "job_green" }, racing);
    await new Promise((r) => setTimeout(r, 5));
    const second = await handleExecute({ token: `tok:${lead.id}`, jobId: "job_green" }, racing);
    expect(second).toMatchObject({ ok: false, code: "invalid_state", status: 409 });
    release();
    const r1 = await first;
    expect(r1.ok && r1.result.status).toBe("COMPLETED");
    expect(d.store.data.artifacts.filter((a) => a.jobId === "job_green").length).toBe(1);
  });

  it("action fingerprint is SHA-256 and covers inputs, tools and provider policy", () => {
    const { job } = greenJob();
    const fp = actionFingerprint(job);
    expect(fp).toMatch(/^fp_[0-9a-f]{64}$/);
    expect(actionFingerprint({ ...job, inputArtifactIds: [] })).not.toBe(fp);
    expect(actionFingerprint({ ...job, availableToolIds: ["wp-cli"] })).not.toBe(fp);
    expect(actionFingerprint({ ...job, preferredProvider: "gemini" })).not.toBe(fp);
    expect(actionFingerprint({ ...job, fallbackProviders: [] })).not.toBe(fp);
    expect(actionFingerprint({ ...job })).toBe(fp);
  });

  it("a lowered job tier never bypasses the agent's tier", async () => {
    let { data } = amberJob();
    data = { ...data, agentJobs: data.agentJobs.map((j) => (j.id === "job_amber" ? { ...j, permissionLevel: "GREEN" as const } : j)) };
    const res = await handleExecute({ token: `tok:${member.id}`, jobId: "job_amber" }, deps(data));
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
    expect((res as { permission?: { level: string } }).permission?.level).toBe("AMBER");
  });
});

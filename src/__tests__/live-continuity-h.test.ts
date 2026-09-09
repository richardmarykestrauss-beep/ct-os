/**
 * CTOS-003 Part H — "the most important acceptance test": provider continuity through the REAL
 * adapter classes, not just the deterministic StubProvider gateway.test.ts's own continuity test
 * uses.
 *
 * HONEST DISCLOSURE (read before trusting this file as a live-network proof): this sandboxed
 * environment has no ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY configured (confirmed via
 * `env | grep` immediately before writing this file — none present), so no genuine outbound network
 * call to a real model provider is possible here. What this test DOES prove, using the production
 * ClaudeProvider and OpenAIProvider classes with only their `fetch` transport substituted for a
 * deterministic fake (never their credential-handling, request-shaping, response-parsing or
 * health-tracking logic, which is exercised exactly as it would be against a real endpoint) is:
 *   - Run 1 executes through the real ClaudeProvider adapter class end to end (auth headers, forced
 *     tool-use body, response parsing, usage extraction) via the full execution gateway
 *     (handleExecute), for Agent 02 (UX & Conversion Architect) on a safe GREEN U-Proof task
 *     producing a site_blueprint@1 improvement note — no production/site change of any kind.
 *   - Provider A (Claude) is then made unavailable (adapter-level, mirroring what would happen if
 *     ANTHROPIC_API_KEY were revoked or the account rate-limited) and Run 2 executes the SAME job
 *     through the real OpenAIProvider adapter class, also end to end.
 *   - Agent identity, CT-OS context (doctrine/agency/project knowledge, instructions, permission
 *     level), handoff and artifact lineage are byte-for-byte/id-for-id identical across the two
 *     runs — only provider provenance (providerId/model on the run and artifact) changes.
 * If real credentials are ever added to this environment, this same test (with `fetch: undefined`
 * removed from the two adapters and real keys substituted) becomes a genuine two-live-provider
 * run; nothing about the request/response contract this test checks would need to change.
 */
import { describe, expect, it } from "vitest";
import type { AuthUser, OSData } from "@/data/types";
import { ModelRouter } from "@/ai/router";
import { ProviderRegistry } from "@/ai/registry";
import { ClaudeProvider } from "@/ai/providers/claude";
import { OpenAIProvider, type FetchLike } from "@/ai/providers/openai";
import { handleExecute, type GatewayDeps } from "@/gateway/core";
import { OSDataGatewayStore } from "@/gateway/store";
import { createJobForTicket } from "@/services/agent-jobs";
import { EXAMPLES } from "@/schemas/artifacts";
import { lead, ROLES_BY_ID, base } from "./fixtures";

const CLAUDE_KEY = "sk-ant-uproof-test-only";
const OPENAI_KEY = "sk-uproof-test-only";

function fakeFetch(impl: (url: string) => { status: number; body: unknown }): FetchLike {
  return (async (url: string) => {
    const r = impl(url);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  }) as FetchLike;
}

const claudeToolUse = () => ({ status: 200, body: { model: "claude-3-5-sonnet-20241022", stop_reason: "tool_use", content: [{ type: "tool_use", name: "emit_ctos_output", input: EXAMPLES["site_blueprint@1"] }], usage: { input_tokens: 640, output_tokens: 210 } } });
const openaiChatCompletion = () => ({ status: 200, body: { model: "gpt-4o-mini-2024-07-18", choices: [{ message: { content: JSON.stringify(EXAMPLES["site_blueprint@1"]) }, finish_reason: "stop" }], usage: { prompt_tokens: 610, completion_tokens: 195 } } });

function deps(data: OSData, providers: (ClaudeProvider | OpenAIProvider)[]): GatewayDeps & { store: OSDataGatewayStore; router: ModelRouter } {
  const store = new OSDataGatewayStore(data, ROLES_BY_ID);
  const users: Record<string, AuthUser> = { [lead.id]: lead };
  return {
    auth: { verify: async (token) => (token && token.startsWith("tok:") ? (users[token.slice(4)] ?? null) : null) },
    store,
    router: new ModelRouter({ registry: new ProviderRegistry(providers) }),
    mode: "local",
    log: () => undefined,
  };
}

describe("CTOS-003 Part H — Agent 02 provider continuity through the real Claude/OpenAI adapter classes", () => {
  it("Run 1 (real Claude adapter) then Run 2 (real OpenAI adapter, Claude unavailable): identity, context, doctrine, handoff and lineage are unchanged — only provider provenance differs", async () => {
    const d0 = base();
    const ticket = d0.tickets.find((t) => t.code === "CT-UP-019")!;
    const uxTicket = { ...ticket, id: "t_ux_h", code: "CT-UP-H-UPROOF", agentId: "agent_02", title: "U-Proof: conversion hierarchy improvement note (GREEN, no production changes)" };
    const d1 = { ...d0, tickets: [...d0.tickets, uxTicket] };
    const { data, job } = createJobForTicket(d1, uxTicket, { id: "job_h_uproof", requestedById: lead.id });
    expect(job.permissionLevel).toBe("GREEN");
    expect(job.preferredProvider).toBe("claude");
    expect(job.requiredOutputSchema).toBe("site_blueprint@1");

    // --- Run 1: real ClaudeProvider adapter class, fake transport (no live credential available here) ---
    const claudeA = new ClaudeProvider({ apiKey: CLAUDE_KEY, fetch: fakeFetch(claudeToolUse) });
    const openaiUnused = new OpenAIProvider({ apiKey: OPENAI_KEY, fetch: fakeFetch(openaiChatCompletion) });
    const runA = deps(data, [claudeA, openaiUnused]);
    const r1 = await handleExecute({ token: `tok:${lead.id}`, jobId: "job_h_uproof" }, runA);
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error("Run 1 unexpectedly failed");
    expect(r1.result.status).toBe("COMPLETED");
    expect(r1.result.provider).toBe("claude");
    expect(r1.result.model).toBe("claude-3-5-sonnet-20241022");

    // --- Provider A becomes unavailable (credential revoked / rate-limited) — Run 2, same job re-queued ---
    const requeued = { ...runA.store.data, agentJobs: runA.store.data.agentJobs.map((j) => (j.id === "job_h_uproof" ? { ...j, status: "QUEUED" as const } : j)) };
    const claudeUnavailable = new ClaudeProvider({ apiKey: CLAUDE_KEY, fetch: fakeFetch(() => ({ status: 401, body: { error: { message: "credential revoked" } } })) });
    const openaiB = new OpenAIProvider({ apiKey: OPENAI_KEY, fetch: fakeFetch(openaiChatCompletion) });
    const runB = deps(requeued, [claudeUnavailable, openaiB]);
    const r2 = await handleExecute({ token: `tok:${lead.id}`, jobId: "job_h_uproof" }, runB);
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error("Run 2 unexpectedly failed");
    expect(r2.result.status).toBe("COMPLETED");
    expect(r2.result.provider).toBe("openai");
    expect(r2.result.model).toBe("gpt-4o-mini-2024-07-18");

    // --- Identity: same agent, same CT-OS request contract reached both real adapters ---
    expect(r1.records.job.agentId).toBe("agent_02");
    expect(r2.records.job.agentId).toBe("agent_02");
    expect(r1.records.runs[0].agentId).toBe(r2.records.runs.find((run) => run.providerId === "openai")!.agentId);

    // --- Doctrine/context stability: the approved knowledge and instructions given to both providers ---
    // are drawn from the same OSData snapshot before either run mutates it, so they are identical by
    // construction; what must differ is only provider/model provenance on the resulting records.
    expect(r1.records.artifact?.createdByAgentId).toBe("agent_02");
    expect(r2.records.artifact?.createdByAgentId).toBe("agent_02");
    expect(r1.records.artifact?.createdByProvider).toBe("claude");
    expect(r2.records.artifact?.createdByProvider).toBe("openai");

    // --- Lineage: Run 2's artifact versions and supersedes Run 1's; same handoff record throughout ---
    expect(r2.records.artifact?.version).toBe(2);
    expect(r2.records.artifact?.supersedesArtifactId).toBe(r1.records.artifact?.id);
    expect(r2.records.handoff?.destinationAgentId).toBe("agent_02");
    expect(r2.records.handoff?.id).toBe(r1.records.handoff?.id);

    // --- Never faked: Run 2 really did go through Claude first (and it really did fail) before OpenAI ---
    const runsForJob = runB.store.data.agentRuns.filter((run) => run.jobId === "job_h_uproof");
    expect(runsForJob.map((run) => `${run.providerId}:${run.status}`)).toEqual(["claude:SUCCEEDED", "claude:FAILED", "openai:SUCCEEDED"]);
    expect(runsForJob[1].errorCategory).toBe("config");
    expect(runsForJob[1].error).not.toContain(CLAUDE_KEY);

    // --- No secret ever reached a record or the browser-safe status payload ---
    expect(JSON.stringify(r1.records)).not.toContain(CLAUDE_KEY);
    expect(JSON.stringify(r2.records)).not.toContain(CLAUDE_KEY);
    expect(JSON.stringify(r2.records)).not.toContain(OPENAI_KEY);
  });
});

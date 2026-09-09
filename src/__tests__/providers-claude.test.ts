/**
 * Claude adapter (CTOS-003 Part C) — mirrors providers.test.ts's OpenAI coverage exactly: fake
 * transport, forced tool-use structured output, refusal/error handling, secret redaction. No
 * network is touched anywhere in this file.
 */
import { describe, expect, it } from "vitest";
import { ClaudeProvider, CLAUDE_ENV_VAR, type ClaudeProviderOptions } from "@/ai/providers/claude";
import type { FetchLike } from "@/ai/providers/openai";
import { ModelRouter } from "@/ai/router";
import { buildProviderRequest, createJob } from "@/services/agent-jobs";
import { EXAMPLES } from "@/schemas/artifacts";
import { base } from "./fixtures";

const SECRET = "sk-ant-test-SECRET-VALUE-0123456789";

function request() {
  const { data, job } = createJob(base(), { projectId: "proj_uproof", agentId: "agent_08", instructions: "Summarise one QA lesson.", inputArtifactIds: ["art_up_qa"] });
  return buildProviderRequest(data, job);
}

function fakeFetch(impl: (url: string, init: Parameters<FetchLike>[1]) => { status: number; body: unknown }): FetchLike & { calls: { url: string; init: Parameters<FetchLike>[1] }[] } {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const f = (async (url: string, init: Parameters<FetchLike>[1]) => {
    calls.push({ url, init });
    const r = impl(url, init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const toolUse = (input: unknown, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { model: "claude-3-5-sonnet-20241022", stop_reason: "tool_use", content: [{ type: "tool_use", name: "emit_ctos_output", input }], usage: { input_tokens: 900, output_tokens: 150 }, ...extra },
});

describe("Claude adapter (live path, fake transport)", () => {
  it("reports not-configured without a key and never calls out", async () => {
    const fetch = fakeFetch(() => toolUse({}));
    const p = new ClaudeProvider({ fetch });
    expect(p.connected).toBe(false);
    expect(p.connectionState).toBe("not_configured");
    expect(p.availability()).toEqual({ available: false, reason: `not configured (${CLAUDE_ENV_VAR})` });
    await expect(p.execute(request())).rejects.toThrow(/not configured/);
    expect(fetch.calls.length).toBe(0);
  });

  it("sends a provider-neutral request as a forced tool call and normalises the response", async () => {
    const fetch = fakeFetch(() => toolUse(EXAMPLES["lesson_candidate@1"]));
    const p = new ClaudeProvider({ apiKey: SECRET, fetch, model: "claude-3-5-sonnet-20241022" });
    expect(p.connected).toBe(true);
    expect(p.connectionState).toBe("connected");
    const res = await p.execute(request());
    expect(res.providerId).toBe("claude");
    expect(res.model).toBe("claude-3-5-sonnet-20241022");
    expect(res.finishReason).toBe("complete");
    expect(res.usage).toEqual({ inputTokens: 900, outputTokens: 150 });
    expect(res.output).toEqual(EXAMPLES["lesson_candidate@1"]);
    expect(res.summary).toBe("Stub lesson candidates.");
    const call = fetch.calls[0];
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.init.headers["x-api-key"]).toBe(SECRET);
    expect(call.init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.init.headers.authorization).toBeUndefined();
    const body = JSON.parse(call.init.body) as { model: string; system: string; messages: { role: string; content: string }[]; tools: { name: string; input_schema: { properties: Record<string, unknown> } }[]; tool_choice: { type: string; name: string } };
    expect(body.model).toBe("claude-3-5-sonnet-20241022");
    expect(body.system).toContain("08 Intelligence Curator");
    expect(body.system).toContain("DOCTRINE (permanent Creative Touch rules)");
    expect(body.messages[0].content).toContain("INPUT ARTIFACTS");
    expect(body.tools[0].name).toBe("emit_ctos_output");
    expect(body.tool_choice).toEqual({ type: "tool", name: "emit_ctos_output" });
    expect(Object.keys(body.tools[0].input_schema.properties)).toEqual(["summary", "lessons"]);
  });

  it("maps HTTP failures to error categories and never echoes the key", async () => {
    const p401 = new ClaudeProvider({ apiKey: SECRET, fetch: fakeFetch(() => ({ status: 401, body: { error: { message: `bad key ${SECRET}` } } })) });
    await expect(p401.execute(request())).rejects.toMatchObject({ category: "config", retryable: false });
    await expect(p401.execute(request())).rejects.not.toThrow(SECRET);
    const p429 = new ClaudeProvider({ apiKey: SECRET, fetch: fakeFetch(() => ({ status: 429, body: {} })) });
    await expect(p429.execute(request())).rejects.toMatchObject({ category: "provider_unavailable", retryable: true });
    const pNet = new ClaudeProvider({ apiKey: SECRET, fetch: (async () => { throw new Error(`ECONNRESET while sending ${SECRET}`); }) as unknown as FetchLike });
    const err = await pNet.execute(request()).catch((e: Error) => e);
    expect(err).toMatchObject({ category: "provider_unavailable" });
    expect(String(err)).not.toContain(SECRET);
    expect(String(err)).toContain("[redacted]");
  });

  it("a safety refusal (stop_reason: refusal) and truncation (max_tokens) surface without an artifact", async () => {
    const req = request();
    const refusal = new ClaudeProvider({ apiKey: SECRET, fetch: fakeFetch(() => ({ status: 200, body: { model: "m", stop_reason: "refusal", content: [{ type: "text", text: "I can't help with that." }] } })) });
    const r1 = await refusal.execute(req);
    expect(r1.finishReason).toBe("refused");
    expect(r1.output).toBeNull();
    expect(r1.summary).toContain("I can't help with that.");

    const truncated = new ClaudeProvider({ apiKey: SECRET, fetch: fakeFetch(() => toolUse({ summary: "cut off" }, { stop_reason: "max_tokens" })) });
    const r2 = await truncated.execute(req);
    expect(r2.finishReason).toBe("truncated");
    expect(r2.output).toEqual({ summary: "cut off" });
  });

  it("non-tool-call text is handed to validation as unparsed output, never silently dropped", async () => {
    const req = request();
    const noTool = new ClaudeProvider({ apiKey: SECRET, fetch: fakeFetch(() => ({ status: 200, body: { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "Sure! Here is the lesson: ..." }] } })) });
    const res = await noTool.execute(req);
    expect(res.output).toMatchObject({ _unparsed: expect.stringContaining("Sure!") });
  });

  it("the router validates the live adapter's output like any other provider (fallback on bad output)", async () => {
    const { ProviderRegistry } = await import("@/ai/registry");
    const { StubProvider } = await import("@/ai/providers/stub");
    // Agent 08 requires long_context; the default OpenAI stub lacks it, so the fallback here is
    // Gemini (which has it by default) — mirrors gateway.test.ts's "A08 needs long_context" case.
    const bad = new ClaudeProvider({ apiKey: SECRET, fetch: fakeFetch(() => toolUse({ summary: "missing lessons" })) });
    const router = new ModelRouter({ registry: new ProviderRegistry([bad, new StubProvider({ id: "gemini" })]) });
    const req = { ...request(), preferredProvider: "claude" as const, fallbackProviders: ["gemini" as const] };
    const res = await router.execute(req);
    expect(res.providerId).toBe("gemini");
    expect(res.attempts.map((a) => `${a.providerId}:${a.outcome}`)).toEqual(["claude:failed_validation", "gemini:succeeded"]);
    expect(res.attempts[0].model).toBe("claude-3-5-sonnet-20241022");
    expect(res.attempts[0].usage).toEqual({ inputTokens: 900, outputTokens: 150 });
  });

  it("a policy-disabled adapter never calls out, regardless of credential (CTOS-003 Part N)", async () => {
    const fetch = fakeFetch(() => toolUse({}));
    const p = new ClaudeProvider({ apiKey: SECRET, fetch, disabled: true } satisfies ClaudeProviderOptions);
    expect(p.connected).toBe(false);
    expect(p.connectionState).toBe("disabled");
    expect(p.availability()).toEqual({ available: false, reason: "disabled by policy" });
    await expect(p.execute(request())).rejects.toMatchObject({ category: "config" });
    expect(fetch.calls.length).toBe(0);
  });
});

describe("Claude adapter secret isolation", () => {
  it("the provider key never appears in request envelopes, responses or run records", async () => {
    const fetch = fakeFetch(() => toolUse(EXAMPLES["lesson_candidate@1"]));
    const p = new ClaudeProvider({ apiKey: SECRET, fetch });
    const req = request();
    const res = await p.execute(req);
    expect(JSON.stringify(req)).not.toContain(SECRET);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(Object.keys(res)).not.toContain("apiKey");
  });
});

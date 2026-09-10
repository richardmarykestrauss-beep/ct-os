/**
 * Provider adapters — the live OpenAI adapter against a fake fetch, registries and secret isolation.
 * No network is touched anywhere in this file.
 */
import { describe, expect, it } from "vitest";
import { OpenAIProvider, OPENAI_ENV_VAR, type FetchLike } from "@/ai/providers/openai";
import { createBrowserRegistry, createServerRegistry, PROVIDER_ENV_VARS } from "@/ai/registry";
import { ModelRouter } from "@/ai/router";
import { buildProviderRequest, createJob } from "@/services/agent-jobs";
import { EXAMPLES } from "@/schemas/artifacts";
import { base } from "./fixtures";

const SECRET = "sk-test-SECRET-VALUE-0123456789";

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

const completion = (content: unknown, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { model: "gpt-4o-mini-2024-07-18", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 812, completion_tokens: 204 }, ...extra },
});

describe("OpenAI adapter (live path, fake transport)", () => {
  it("reports not-configured without a key and never calls out", async () => {
    const fetch = fakeFetch(() => completion({}));
    const p = new OpenAIProvider({ fetch });
    expect(p.connected).toBe(false);
    expect(p.connectionState).toBe("not_configured");
    expect(p.availability()).toEqual({ available: false, reason: `not configured (${OPENAI_ENV_VAR})` });
    await expect(p.execute(request())).rejects.toThrow(/not configured/);
    expect(fetch.calls.length).toBe(0);
  });

  it("sends a provider-neutral request as chat completions with a JSON-schema response format, and normalises the response", async () => {
    const fetch = fakeFetch(() => completion(EXAMPLES["lesson_candidate@1"]));
    const p = new OpenAIProvider({ apiKey: SECRET, fetch, model: "gpt-4o-mini" });
    expect(p.connected).toBe(true);
    expect(p.connectionState).toBe("connected");
    const res = await p.execute(request());
    expect(res.providerId).toBe("openai");
    expect(res.model).toBe("gpt-4o-mini-2024-07-18");
    expect(res.finishReason).toBe("complete");
    expect(res.usage).toEqual({ inputTokens: 812, outputTokens: 204 });
    expect(res.output).toEqual(EXAMPLES["lesson_candidate@1"]);
    expect(res.summary).toBe("Stub lesson candidates.");
    const call = fetch.calls[0];
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(call.init.headers.authorization).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(call.init.body) as { model: string; messages: { role: string; content: string }[]; response_format: { type: string; json_schema: { name: string; schema: { properties: Record<string, unknown> } } } };
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("08 Curator");
    expect(body.messages[0].content).toContain("DOCTRINE (permanent Creative Touch rules)");
    expect(body.messages[1].content).toContain("INPUT ARTIFACTS");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("lesson_candidate_1");
    expect(Object.keys(body.response_format.json_schema.schema.properties)).toEqual(["summary", "lessons"]);
  });

  it("maps HTTP failures to error categories and never echoes the key", async () => {
    const p401 = new OpenAIProvider({ apiKey: SECRET, fetch: fakeFetch(() => ({ status: 401, body: { error: { message: `bad key ${SECRET}` } } })) });
    await expect(p401.execute(request())).rejects.toMatchObject({ category: "config", retryable: false });
    await expect(p401.execute(request())).rejects.not.toThrow(SECRET);
    const p429 = new OpenAIProvider({ apiKey: SECRET, fetch: fakeFetch(() => ({ status: 429, body: {} })) });
    await expect(p429.execute(request())).rejects.toMatchObject({ category: "provider_unavailable", retryable: true });
    const pNet = new OpenAIProvider({ apiKey: SECRET, fetch: (async () => { throw new Error(`ECONNRESET while sending ${SECRET}`); }) as unknown as FetchLike });
    const err = await pNet.execute(request()).catch((e: Error) => e);
    expect(err).toMatchObject({ category: "provider_unavailable" });
    expect(String(err)).not.toContain(SECRET);
    expect(String(err)).toContain("[redacted]");
  });

  it("non-JSON content and refusals surface as validation/provider failures, not artifacts", async () => {
    const req = request();
    const text = new OpenAIProvider({ apiKey: SECRET, fetch: fakeFetch(() => completion("Sure! Here is the lesson: ...")) });
    const r1 = await text.execute(req);
    expect(r1.output).toMatchObject({ _unparsed: expect.stringContaining("Sure!") });
    const refusal = new OpenAIProvider({ apiKey: SECRET, fetch: fakeFetch(() => ({ status: 200, body: { model: "m", choices: [{ message: { content: null, refusal: "I can't help with that." } }] } })) });
    const r2 = await refusal.execute(req);
    expect(r2.finishReason).toBe("refused");
    expect(r2.output).toBeNull();
  });

  it("the router validates the live adapter's output like any other provider (fallback on bad output)", async () => {
    const { ProviderRegistry } = await import("@/ai/registry");
    const { StubProvider } = await import("@/ai/providers/stub");
    const bad = new OpenAIProvider({ apiKey: SECRET, fetch: fakeFetch(() => completion({ summary: "missing lessons" })), capabilities: ["text", "structured_output", "long_context", "vision", "code", "review"] });
    const router = new ModelRouter({ registry: new ProviderRegistry([bad, new StubProvider({ id: "claude" })]) });
    const req = { ...request(), preferredProvider: "openai" as const, fallbackProviders: ["claude" as const] };
    const res = await router.execute(req);
    expect(res.providerId).toBe("claude");
    expect(res.attempts.map((a) => `${a.providerId}:${a.outcome}`)).toEqual(["openai:failed_validation", "claude:succeeded"]);
    expect(res.attempts[0].model).toBe("gpt-4o-mini-2024-07-18");
    expect(res.attempts[0].usage).toEqual({ inputTokens: 812, outputTokens: 204 });
  });
});

describe("registries and secret isolation", () => {
  it("the browser registry holds stubs only and has no way to carry a credential", async () => {
    const reg = createBrowserRegistry();
    for (const p of reg.all()) {
      expect(p.connected).toBe(false);
      expect(p.connectionState).toBe("stub");
      expect(JSON.stringify(p)).not.toMatch(/apiKey|sk-/);
    }
    expect((await reg.status()).every((s) => s.state === "stub" && s.available)).toBe(true);
  });

  it("the server registry builds a live OpenAI adapter from the environment and reports the others as not configured", async () => {
    const reg = createServerRegistry({ OPENAI_API_KEY: SECRET, OPENAI_MODEL: "gpt-4o" }, { fetch: fakeFetch(() => completion({})) });
    const status = await reg.status();
    expect(status.map((s) => `${s.id}:${s.state}:${s.available}`)).toEqual(["claude:not_configured:false", "openai:connected:true", "gemini:not_configured:false"]);
    expect(status.find((s) => s.id === "claude")?.reason).toBe("not configured (ANTHROPIC_API_KEY)");
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(PROVIDER_ENV_VARS).toEqual({ claude: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" });
  });

  it("without any key the server registry has no available provider unless stubs are explicitly allowed", async () => {
    const none = await createServerRegistry({}).status();
    expect(none.every((s) => !s.available && s.state === "not_configured")).toBe(true);
    const dev = await createServerRegistry({ CTOS_ALLOW_STUB_PROVIDERS: "1" }).status();
    expect(dev.every((s) => s.available && s.state === "stub")).toBe(true);
  });

  it("the provider key never appears in request envelopes, responses or run records", async () => {
    const fetch = fakeFetch(() => completion(EXAMPLES["lesson_candidate@1"]));
    const p = new OpenAIProvider({ apiKey: SECRET, fetch });
    const req = request();
    const res = await p.execute(req);
    expect(JSON.stringify(req)).not.toContain(SECRET);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(Object.keys(res)).not.toContain("apiKey");
  });
});

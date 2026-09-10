/**
 * Gemini adapter (CTOS-003 Part D) — mirrors providers.test.ts's OpenAI coverage: fake transport,
 * structured JSON output, refusal handling (both prompt-level blockReason and per-candidate
 * finishReason), error mapping, secret redaction. No network is touched anywhere in this file.
 */
import { describe, expect, it } from "vitest";
import { GeminiProvider, GEMINI_ENV_VAR, type GeminiProviderOptions } from "@/ai/providers/gemini";
import type { FetchLike } from "@/ai/providers/openai";
import { ModelRouter } from "@/ai/router";
import { buildProviderRequest, createJob } from "@/services/agent-jobs";
import { EXAMPLES } from "@/schemas/artifacts";
import { base } from "./fixtures";

const SECRET = "AIzaSy-test-SECRET-VALUE-0123456789";

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

const generated = (text: unknown, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { modelVersion: "gemini-1.5-flash-001", candidates: [{ content: { parts: [{ text: typeof text === "string" ? text : JSON.stringify(text) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 120 }, ...extra },
});

describe("Gemini adapter (live path, fake transport)", () => {
  it("reports not-configured without a key and never calls out", async () => {
    const fetch = fakeFetch(() => generated({}));
    const p = new GeminiProvider({ fetch });
    expect(p.connected).toBe(false);
    expect(p.connectionState).toBe("not_configured");
    expect(p.availability()).toEqual({ available: false, reason: `not configured (${GEMINI_ENV_VAR})` });
    await expect(p.execute(request())).rejects.toThrow(/not configured/);
    expect(fetch.calls.length).toBe(0);
  });

  it("sends a provider-neutral request with the key as a header (never a query param) and normalises the response", async () => {
    const fetch = fakeFetch(() => generated(EXAMPLES["lesson_candidate@1"]));
    const p = new GeminiProvider({ apiKey: SECRET, fetch, model: "gemini-1.5-flash" });
    expect(p.connected).toBe(true);
    expect(p.connectionState).toBe("connected");
    const res = await p.execute(request());
    expect(res.providerId).toBe("gemini");
    expect(res.model).toBe("gemini-1.5-flash-001");
    expect(res.finishReason).toBe("complete");
    expect(res.usage).toEqual({ inputTokens: 700, outputTokens: 120 });
    expect(res.output).toEqual(EXAMPLES["lesson_candidate@1"]);
    expect(res.summary).toBe("Stub lesson candidates.");
    const call = fetch.calls[0];
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent");
    expect(call.url).not.toContain(SECRET); // the key must never ride in the URL
    expect(call.init.headers["x-goog-api-key"]).toBe(SECRET);
    const body = JSON.parse(call.init.body) as { systemInstruction: { parts: { text: string }[] }; contents: { parts: { text: string }[] }[]; generationConfig: { responseMimeType: string } };
    expect(body.systemInstruction.parts[0].text).toContain("08 Curator");
    expect(body.systemInstruction.parts[0].text).toContain("DOCTRINE (permanent Creative Touch rules)");
    expect(body.contents[0].parts[0].text).toContain("INPUT ARTIFACTS");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("maps HTTP failures to error categories and never echoes the key", async () => {
    const p401 = new GeminiProvider({ apiKey: SECRET, fetch: fakeFetch(() => ({ status: 401, body: { error: { message: `bad key ${SECRET}` } } })) });
    await expect(p401.execute(request())).rejects.toMatchObject({ category: "config", retryable: false });
    await expect(p401.execute(request())).rejects.not.toThrow(SECRET);
    const p429 = new GeminiProvider({ apiKey: SECRET, fetch: fakeFetch(() => ({ status: 429, body: {} })) });
    await expect(p429.execute(request())).rejects.toMatchObject({ category: "provider_unavailable", retryable: true });
    const pNet = new GeminiProvider({ apiKey: SECRET, fetch: (async () => { throw new Error(`ECONNRESET while sending ${SECRET}`); }) as unknown as FetchLike });
    const err = await pNet.execute(request()).catch((e: Error) => e);
    expect(err).toMatchObject({ category: "provider_unavailable" });
    expect(String(err)).not.toContain(SECRET);
    expect(String(err)).toContain("[redacted]");
  });

  it("a prompt-level block (promptFeedback.blockReason) surfaces as a refusal with no candidate needed", async () => {
    const req = request();
    const blocked = new GeminiProvider({ apiKey: SECRET, fetch: fakeFetch(() => ({ status: 200, body: { modelVersion: "m", promptFeedback: { blockReason: "SAFETY" } } })) });
    const res = await blocked.execute(req);
    expect(res.finishReason).toBe("refused");
    expect(res.output).toBeNull();
    expect(res.summary).toContain("SAFETY");
  });

  it("a per-candidate safety/recitation finishReason also surfaces as a refusal, and MAX_TOKENS as truncated", async () => {
    const req = request();
    const safety = new GeminiProvider({ apiKey: SECRET, fetch: fakeFetch(() => ({ status: 200, body: { modelVersion: "m", candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "SAFETY" }] } })) });
    const r1 = await safety.execute(req);
    expect(r1.finishReason).toBe("refused");
    expect(r1.output).toBeNull();

    const truncated = new GeminiProvider({ apiKey: SECRET, fetch: fakeFetch(() => generated({ summary: "cut off" }, { candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: "cut off" }) }] }, finishReason: "MAX_TOKENS" }] })) });
    const r2 = await truncated.execute(req);
    expect(r2.finishReason).toBe("truncated");
    expect(r2.output).toEqual({ summary: "cut off" });
  });

  it("non-JSON content is handed to validation as unparsed output, never silently dropped", async () => {
    const req = request();
    const text = new GeminiProvider({ apiKey: SECRET, fetch: fakeFetch(() => generated("Sure! Here is the lesson: ...")) });
    const res = await text.execute(req);
    expect(res.output).toMatchObject({ _unparsed: expect.stringContaining("Sure!") });
  });

  it("the router validates the live adapter's output like any other provider (fallback on bad output)", async () => {
    const { ProviderRegistry } = await import("@/ai/registry");
    const { StubProvider } = await import("@/ai/providers/stub");
    // Agent 08 requires long_context; the default OpenAI stub lacks it, so the fallback here is
    // Claude (which has it by default) — mirrors gateway.test.ts's "A08 needs long_context" case.
    const bad = new GeminiProvider({ apiKey: SECRET, fetch: fakeFetch(() => generated({ summary: "missing lessons" })) });
    const router = new ModelRouter({ registry: new ProviderRegistry([bad, new StubProvider({ id: "claude" })]) });
    const req = { ...request(), preferredProvider: "gemini" as const, fallbackProviders: ["claude" as const] };
    const res = await router.execute(req);
    expect(res.providerId).toBe("claude");
    expect(res.attempts.map((a) => `${a.providerId}:${a.outcome}`)).toEqual(["gemini:failed_validation", "claude:succeeded"]);
    expect(res.attempts[0].model).toBe("gemini-1.5-flash-001");
    expect(res.attempts[0].usage).toEqual({ inputTokens: 700, outputTokens: 120 });
  });

  it("a policy-disabled adapter never calls out, regardless of credential (CTOS-003 Part N)", async () => {
    const fetch = fakeFetch(() => generated({}));
    const p = new GeminiProvider({ apiKey: SECRET, fetch, disabled: true } satisfies GeminiProviderOptions);
    expect(p.connected).toBe(false);
    expect(p.connectionState).toBe("disabled");
    expect(p.availability()).toEqual({ available: false, reason: "disabled by policy" });
    await expect(p.execute(request())).rejects.toMatchObject({ category: "config" });
    expect(fetch.calls.length).toBe(0);
  });
});

describe("Gemini adapter secret isolation", () => {
  it("the provider key never appears in request envelopes, responses or run records", async () => {
    const fetch = fakeFetch(() => generated(EXAMPLES["lesson_candidate@1"]));
    const p = new GeminiProvider({ apiKey: SECRET, fetch });
    const req = request();
    const res = await p.execute(req);
    expect(JSON.stringify(req)).not.toContain(SECRET);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(Object.keys(res)).not.toContain("apiKey");
  });
});

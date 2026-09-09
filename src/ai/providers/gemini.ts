/**
 * GeminiProvider - Google Gemini adapter (CTOS-003 Part D).
 *
 * SERVER-SIDE ONLY, mirroring OpenAIProvider/ClaudeProvider's contract and error-handling shape
 * (same ProviderError categories, same timeout pattern, same key-redaction discipline). Nothing
 * Gemini-specific (candidates, `finishReason` strings, `usageMetadata`) crosses out of this file.
 *
 * Auth: the key is sent as the `x-goog-api-key` header, not a `?key=` query parameter - Gemini's
 * REST API supports both, but a header never ends up in a URL, a browser history, a proxy access
 * log or the `call.url` a test/log might capture, which the query-param form would risk.
 *
 * Structured output: `generationConfig.responseMimeType: "application/json"`. CTOS-003A found that
 * Gemini's `responseSchema` field (its OpenAPI-3.0-subset structural constraint) rejects this
 * project's Zod-derived JSON Schema outright (HTTP 400 "invalid argument") even after stripping
 * every documented-unsupported keyword ($schema/additionalProperties/default/minLength/etc.) -
 * the API gives no field-level detail to debug further, and CT-OS validates every response with
 * Zod regardless of what a provider structurally enforces. So instead `buildUserMessage` renders
 * the exact required JSON Schema as text in the prompt (see below) - a strictly lower-risk way to
 * raise compliance than a provider-side constraint that can outright reject the request.
 */
import type { ProviderCapability, ProviderId } from "@/data/types";
import { ProviderError, type AIProvider, type ProviderAvailability, type ProviderConnectionState, type ProviderRequest, type ProviderResponse } from "../types";
import { DEFAULT_CAPABILITIES } from "./stub";
import { HealthTracker } from "./health";
import type { FetchLike } from "./openai";

export const GEMINI_ENV_VAR = "GEMINI_API_KEY";
export const GEMINI_MODEL_ENV_VAR = "GEMINI_MODEL";
// CTOS-004A: gemini-3.6-flash is CT-OS's tested reliability baseline (verified with a genuine
// execution in CTOS-003). gemini-3.8-flash remains fully supported via GEMINI_MODEL for a
// higher-tier run when it's healthy, but is not the unconfigured default - 3.6 is. A 503/other
// transient failure from whichever model is configured does not retry in place: HealthTracker
// records it and ModelRouter.execute() (src/ai/router.ts) moves on to the next provider in the
// job's fallback sequence - see docs/PROVIDER-ADAPTERS.md "Gemini adapter behaviour".
export const GEMINI_DEFAULT_MODEL = "gemini-3.6-flash";

const REFUSAL_FINISH_REASONS = new Set(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "OTHER"]);

export interface GeminiProviderOptions {
  /** Present only inside the gateway. Absent -> adapter reports "not configured" and never calls out. */
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  capabilities?: ProviderCapability[];
  disabled?: boolean;
  healthCooldownMs?: number;
  healthClock?: () => number;
}

interface GeminiResponse {
  modelVersion?: string;
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export class GeminiProvider implements AIProvider {
  readonly id: ProviderId = "gemini";
  readonly displayName = "Gemini";
  readonly capabilities: ProviderCapability[];
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | null;
  private readonly timeoutMs: number;
  private readonly disabledFlag: boolean;
  private readonly health: HealthTracker;

  constructor(opts: GeminiProviderOptions = {}) {
    this.apiKey = opts.apiKey?.trim() || null;
    this.model = opts.model?.trim() || GEMINI_DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch ?? null);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES.gemini;
    this.disabledFlag = opts.disabled ?? false;
    this.health = new HealthTracker({ cooldownMs: opts.healthCooldownMs, clock: opts.healthClock });
  }

  get connected(): boolean {
    return !!this.apiKey && !this.disabledFlag;
  }

  get connectionState(): ProviderConnectionState {
    if (this.disabledFlag) return "disabled";
    if (!this.apiKey) return "not_configured";
    return this.health.state() ?? "connected";
  }

  availability(): ProviderAvailability {
    if (this.disabledFlag) return { available: false, reason: "disabled by policy" };
    if (!this.apiKey) return { available: false, reason: `not configured (${GEMINI_ENV_VAR})` };
    if (!this.fetchImpl) return { available: false, reason: "no fetch implementation in this runtime" };
    if (this.health.blocksAvailability()) return { available: false, reason: this.health.reason()! };
    return { available: true };
  }

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    if (this.disabledFlag) throw new ProviderError(this.id, "Gemini adapter is disabled by policy", "config", false);
    if (!this.apiKey || !this.fetchImpl) throw new ProviderError(this.id, `Gemini adapter is not configured (${GEMINI_ENV_VAR})`, "config", false);
    const body = {
      systemInstruction: { parts: [{ text: request.systemContext }] },
      contents: [{ role: "user", parts: [{ text: buildUserMessage(request) }] }],
      generationConfig: { responseMimeType: "application/json" },
    };
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let json: GeminiResponse;
    try {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(body),
          signal: controller?.signal,
        });
      } catch (err) {
        this.health.recordFailure("provider_unavailable", null);
        throw new ProviderError(this.id, `Gemini request failed: ${sanitize(err instanceof Error ? err.message : String(err), this.apiKey)}`, "provider_unavailable", true);
      }
      if (!res.ok) {
        const text = sanitize((await res.text().catch(() => "")).slice(0, 300), this.apiKey);
        const category = res.status === 401 || res.status === 403 ? "config" : res.status === 429 || res.status >= 500 ? "provider_unavailable" : "provider_error";
        this.health.recordFailure(category, res.status);
        throw new ProviderError(this.id, `Gemini HTTP ${res.status}${text ? `: ${text}` : ""}`, category, category !== "config");
      }
      try {
        json = (await res.json()) as GeminiResponse;
      } catch (err) {
        throw new ProviderError(this.id, `Gemini returned an unreadable body: ${sanitize(err instanceof Error ? err.message : String(err), this.apiKey)}`, "provider_error", true);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.health.recordSuccess();
    const model = json.modelVersion ?? this.model;
    const usage = usageOf(json);
    // Blocked before any candidate was produced (e.g. a prompt-level safety block).
    if (json.promptFeedback?.blockReason) {
      return { providerId: this.id, model, output: null, summary: `Gemini refused: blocked (${json.promptFeedback.blockReason})`, usage, finishReason: "refused" };
    }
    const candidate = json.candidates?.[0];
    if (candidate?.finishReason && REFUSAL_FINISH_REASONS.has(candidate.finishReason)) {
      return { providerId: this.id, model, output: null, summary: `Gemini refused: ${candidate.finishReason}`, usage, finishReason: "refused" };
    }
    const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      output = { _unparsed: text.slice(0, 2000) };
    }
    return {
      providerId: this.id,
      model,
      output,
      summary: summarize(output, request),
      usage,
      finishReason: candidate?.finishReason === "MAX_TOKENS" ? "truncated" : "complete",
    };
  }
}

function buildUserMessage(request: ProviderRequest): string {
  const parts: string[] = [];
  parts.push(`TASK (${request.taskType}):\n${request.instructions}`);
  if (request.inputArtifacts.length) {
    parts.push(
      `INPUT ARTIFACTS:\n${request.inputArtifacts
        .map((a) => `- ${a.type} v${a.version} "${a.title}"${a.summary ? `: ${a.summary}` : ""}${a.content !== undefined && a.content !== null ? `\n  content: ${JSON.stringify(a.content).slice(0, 6000)}` : ""}`)
        .join("\n")}`,
    );
  }
  if (request.availableTools.length) parts.push(`AVAILABLE TOOLS: ${request.availableTools.join(", ")}`);
  // CTOS-003A: Gemini has no provider-side structural output constraint here (see file header),
  // so - unlike the OpenAI/Claude adapters, which pass request.outputJsonSchema to the API itself
  // - the exact required JSON Schema is spelled out in the prompt text instead. This is strictly
  // additive to the existing instruction and cannot cause an HTTP-level rejection.
  if (request.outputJsonSchema) {
    parts.push(`Respond with a single JSON object that strictly matches this JSON Schema (every "required" field must be present, including in nested array items):\n${JSON.stringify(request.outputJsonSchema)}`);
  } else {
    parts.push(`Respond with a single JSON object that satisfies the "${request.requiredOutputSchema}" schema. No prose outside the JSON.`);
  }
  return parts.join("\n\n");
}

function usageOf(json: GeminiResponse) {
  return { inputTokens: json.usageMetadata?.promptTokenCount ?? null, outputTokens: json.usageMetadata?.candidatesTokenCount ?? null };
}

function summarize(output: unknown, request: ProviderRequest): string {
  const summary = output && typeof output === "object" && typeof (output as { summary?: unknown }).summary === "string" ? (output as { summary: string }).summary : null;
  return summary ? summary.slice(0, 400) : `Gemini produced a ${request.requiredOutputSchema} response.`;
}

/** Defence in depth: never let the key echo through an error message. */
function sanitize(text: string, apiKey: string | null): string {
  return apiKey ? text.split(apiKey).join("[redacted]") : text;
}

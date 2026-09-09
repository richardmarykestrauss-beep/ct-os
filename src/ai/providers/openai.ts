/**
 * OpenAIProvider — the first live adapter (CTOS-002).
 *
 * SERVER-SIDE ONLY. It is constructed by `createServerRegistry()` inside the execution gateway,
 * where OPENAI_API_KEY lives. The browser registry never instantiates it with a key, and the key
 * never appears in any request/response object, log line or error message.
 *
 * Uses the Chat Completions endpoint with a JSON-schema response format derived from the job's
 * required output schema. CT-OS still validates the result with Zod — the provider's own schema
 * enforcement is a hint, not a guarantee.
 */
import type { ProviderCapability, ProviderId } from "@/data/types";
import { ProviderError, type AIProvider, type ProviderAvailability, type ProviderConnectionState, type ProviderRequest, type ProviderResponse } from "../types";
import { DEFAULT_CAPABILITIES } from "./stub";
import { HealthTracker } from "./health";

export const OPENAI_ENV_VAR = "OPENAI_API_KEY";
export const OPENAI_MODEL_ENV_VAR = "OPENAI_MODEL";
export const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface OpenAIProviderOptions {
  /** Present only inside the gateway. Absent → adapter reports "not configured" and never calls out. */
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: FetchLike;
  timeoutMs?: number;
  capabilities?: ProviderCapability[];
  /** Turned off by policy regardless of credential (CTOS-003 Part N). */
  disabled?: boolean;
  /** Test seams for the health tracker's cooldown window. */
  healthCooldownMs?: number;
  healthClock?: () => number;
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAIProvider implements AIProvider {
  readonly id: ProviderId = "openai";
  readonly displayName = "OpenAI";
  readonly capabilities: ProviderCapability[];
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | null;
  private readonly timeoutMs: number;
  private readonly disabledFlag: boolean;
  private readonly health: HealthTracker;

  constructor(opts: OpenAIProviderOptions = {}) {
    this.apiKey = opts.apiKey?.trim() || null;
    this.model = opts.model?.trim() || OPENAI_DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch ?? null);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES.openai;
    this.disabledFlag = opts.disabled ?? false;
    this.health = new HealthTracker({ cooldownMs: opts.healthCooldownMs, clock: opts.healthClock });
  }

  get connected(): boolean {
    return !!this.apiKey && !this.disabledFlag;
  }

  /** Never a static field: reflects the credential, policy and the adapter's own recent failures (CTOS-003 Part N). */
  get connectionState(): ProviderConnectionState {
    if (this.disabledFlag) return "disabled";
    if (!this.apiKey) return "not_configured";
    return this.health.state() ?? "connected";
  }

  availability(): ProviderAvailability {
    if (this.disabledFlag) return { available: false, reason: "disabled by policy" };
    if (!this.apiKey) return { available: false, reason: `not configured (${OPENAI_ENV_VAR})` };
    if (!this.fetchImpl) return { available: false, reason: "no fetch implementation in this runtime" };
    if (this.health.blocksAvailability()) return { available: false, reason: this.health.reason()! };
    return { available: true };
  }

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    if (this.disabledFlag) throw new ProviderError(this.id, "OpenAI adapter is disabled by policy", "config", false);
    if (!this.apiKey || !this.fetchImpl) throw new ProviderError(this.id, `OpenAI adapter is not configured (${OPENAI_ENV_VAR})`, "config", false);
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: request.systemContext },
        { role: "user", content: buildUserMessage(request) },
      ],
      response_format: request.outputJsonSchema
        ? { type: "json_schema", json_schema: { name: request.requiredOutputSchema.replace(/[^a-zA-Z0-9_]/g, "_"), schema: request.outputJsonSchema, strict: false } }
        : { type: "json_object" },
    };
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let json: ChatCompletion;
    try {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: controller?.signal,
        });
      } catch (err) {
        this.health.recordFailure("provider_unavailable", null);
        throw new ProviderError(this.id, `OpenAI request failed: ${sanitize(err instanceof Error ? err.message : String(err), this.apiKey)}`, "provider_unavailable", true);
      }
      if (!res.ok) {
        const text = sanitize((await res.text().catch(() => "")).slice(0, 300), this.apiKey);
        const category = res.status === 401 || res.status === 403 ? "config" : res.status === 429 || res.status >= 500 ? "provider_unavailable" : "provider_error";
        this.health.recordFailure(category, res.status);
        throw new ProviderError(this.id, `OpenAI HTTP ${res.status}${text ? `: ${text}` : ""}`, category, category !== "config");
      }
      try {
        json = (await res.json()) as ChatCompletion;
      } catch (err) {
        throw new ProviderError(this.id, `OpenAI returned an unreadable body: ${sanitize(err instanceof Error ? err.message : String(err), this.apiKey)}`, "provider_error", true);
      }
    } finally {
      // Covers the body read as well as the request.
      if (timer) clearTimeout(timer);
    }
    this.health.recordSuccess();
    const choice = json.choices?.[0];
    if (choice?.message?.refusal) {
      return { providerId: this.id, model: json.model ?? this.model, output: null, summary: `OpenAI refused: ${choice.message.refusal.slice(0, 200)}`, usage: usageOf(json), finishReason: "refused" };
    }
    const content = choice?.message?.content ?? "";
    let output: unknown;
    try {
      output = JSON.parse(content);
    } catch {
      // Not JSON: hand it to validation, which will fail with an actionable message.
      output = { _unparsed: content.slice(0, 2000) };
    }
    return {
      providerId: this.id,
      model: json.model ?? this.model,
      output,
      summary: summarize(output, request),
      usage: usageOf(json),
      finishReason: choice?.finish_reason === "length" ? "truncated" : "complete",
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
  parts.push(`Respond with a single JSON object that satisfies the "${request.requiredOutputSchema}" schema. No prose outside the JSON.`);
  return parts.join("\n\n");
}

function usageOf(json: ChatCompletion) {
  return { inputTokens: json.usage?.prompt_tokens ?? null, outputTokens: json.usage?.completion_tokens ?? null };
}

function summarize(output: unknown, request: ProviderRequest): string {
  const summary = output && typeof output === "object" && typeof (output as { summary?: unknown }).summary === "string" ? (output as { summary: string }).summary : null;
  return summary ? summary.slice(0, 400) : `OpenAI produced a ${request.requiredOutputSchema} response.`;
}

/** Defence in depth: never let the key echo through an error message. */
function sanitize(text: string, apiKey: string | null): string {
  return apiKey ? text.split(apiKey).join("[redacted]") : text;
}

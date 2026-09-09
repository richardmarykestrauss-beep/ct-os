/**
 * ClaudeProvider — Anthropic adapter (CTOS-003 Part C).
 *
 * SERVER-SIDE ONLY, mirroring OpenAIProvider's contract and error-handling shape exactly (same
 * ProviderError categories, same timeout/AbortController pattern, same key-redaction discipline)
 * so the router treats every adapter identically. Nothing Anthropic-specific (the Messages API's
 * `content` blocks, `stop_reason`, tool-use shape) crosses out of this file — callers only ever
 * see the neutral ProviderResponse.
 *
 * Structured output: Anthropic's Messages API has no OpenAI-style `response_format`. CT-OS gets a
 * reliable structured JSON object the way Anthropic's own docs recommend for this — a single
 * forced tool call whose input_schema is the job's required output JSON Schema. The model's
 * "tool call" is purely a structured-output mechanism here; it is never treated as a real tool
 * invocation and CT-OS never executes anything because of it.
 */
import type { ProviderCapability, ProviderId } from "@/data/types";
import { ProviderError, type AIProvider, type ProviderAvailability, type ProviderConnectionState, type ProviderRequest, type ProviderResponse } from "../types";
import { DEFAULT_CAPABILITIES } from "./stub";
import { HealthTracker } from "./health";
import type { FetchLike } from "./openai";

export const CLAUDE_ENV_VAR = "ANTHROPIC_API_KEY";
export const CLAUDE_MODEL_ENV_VAR = "ANTHROPIC_MODEL";
export const CLAUDE_DEFAULT_MODEL = "claude-3-5-sonnet-20241022";
const ANTHROPIC_VERSION = "2023-06-01";
const OUTPUT_TOOL_NAME = "emit_ctos_output";

export interface ClaudeProviderOptions {
  /** Present only inside the gateway. Absent → adapter reports "not configured" and never calls out. */
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxOutputTokens?: number;
  capabilities?: ProviderCapability[];
  disabled?: boolean;
  healthCooldownMs?: number;
  healthClock?: () => number;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  input?: unknown;
}

interface AnthropicMessage {
  model?: string;
  stop_reason?: string | null;
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class ClaudeProvider implements AIProvider {
  readonly id: ProviderId = "claude";
  readonly displayName = "Claude";
  readonly capabilities: ProviderCapability[];
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike | null;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly disabledFlag: boolean;
  private readonly health: HealthTracker;

  constructor(opts: ClaudeProviderOptions = {}) {
    this.apiKey = opts.apiKey?.trim() || null;
    this.model = opts.model?.trim() || CLAUDE_DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch ?? null);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxOutputTokens = opts.maxOutputTokens ?? 16000;
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES.claude;
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
    if (!this.apiKey) return { available: false, reason: `not configured (${CLAUDE_ENV_VAR})` };
    if (!this.fetchImpl) return { available: false, reason: "no fetch implementation in this runtime" };
    if (this.health.blocksAvailability()) return { available: false, reason: this.health.reason()! };
    return { available: true };
  }

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    if (this.disabledFlag) throw new ProviderError(this.id, "Claude adapter is disabled by policy", "config", false);
    if (!this.apiKey || !this.fetchImpl) throw new ProviderError(this.id, `Claude adapter is not configured (${CLAUDE_ENV_VAR})`, "config", false);
    const useTool = !!request.outputJsonSchema;
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxOutputTokens,
      system: request.systemContext,
      messages: [{ role: "user", content: buildUserMessage(request, useTool) }],
    };
    if (useTool) {
      body.tools = [{ name: OUTPUT_TOOL_NAME, description: `Return the structured output for the "${request.requiredOutputSchema}" schema. Always call this exactly once with the complete result.`, input_schema: request.outputJsonSchema }];
      body.tool_choice = { type: "tool", name: OUTPUT_TOOL_NAME };
    }
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let json: AnthropicMessage;
    try {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": ANTHROPIC_VERSION },
          body: JSON.stringify(body),
          signal: controller?.signal,
        });
      } catch (err) {
        this.health.recordFailure("provider_unavailable", null);
        throw new ProviderError(this.id, `Claude request failed: ${sanitize(err instanceof Error ? err.message : String(err), this.apiKey)}`, "provider_unavailable", true);
      }
      if (!res.ok) {
        const text = sanitize((await res.text().catch(() => "")).slice(0, 300), this.apiKey);
        const category = res.status === 401 || res.status === 403 ? "config" : res.status === 429 || res.status >= 500 ? "provider_unavailable" : "provider_error";
        this.health.recordFailure(category, res.status);
        throw new ProviderError(this.id, `Claude HTTP ${res.status}${text ? `: ${text}` : ""}`, category, category !== "config");
      }
      try {
        json = (await res.json()) as AnthropicMessage;
      } catch (err) {
        throw new ProviderError(this.id, `Claude returned an unreadable body: ${sanitize(err instanceof Error ? err.message : String(err), this.apiKey)}`, "provider_error", true);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.health.recordSuccess();
    const blocks = json.content ?? [];
    // Anthropic reports a safety-triggered stop with no content as stop_reason "refusal".
    if (json.stop_reason === "refusal") {
      const text = blocks.find((b) => b.type === "text")?.text ?? "Claude declined to respond.";
      return { providerId: this.id, model: json.model ?? this.model, output: null, summary: `Claude refused: ${text.slice(0, 200)}`, usage: usageOf(json), finishReason: "refused" };
    }
    let output: unknown;
    if (useTool) {
      const toolUse = blocks.find((b) => b.type === "tool_use");
      output = toolUse ? toolUse.input : { _unparsed: (blocks.find((b) => b.type === "text")?.text ?? "").slice(0, 2000) };
    } else {
      const text = blocks.find((b) => b.type === "text")?.text ?? "";
      try {
        output = JSON.parse(text);
      } catch {
        output = { _unparsed: text.slice(0, 2000) };
      }
    }
    return {
      providerId: this.id,
      model: json.model ?? this.model,
      output,
      summary: summarize(output, request),
      usage: usageOf(json),
      finishReason: json.stop_reason === "max_tokens" ? "truncated" : "complete",
    };
  }
}

function buildUserMessage(request: ProviderRequest, useTool: boolean): string {
  const parts: string[] = [];
  parts.push(`TASK (${request.taskType}):\n${request.instructions}`);
  if (request.inputArtifacts.length) {
    parts.push(
      `INPUT ARTIFACTS:\n${request.inputArtifacts
        .map((a) => `- ${a.type} v${a.version} "${a.title}"${a.summary ? `: ${a.summary}` : ""}${a.content !== undefined && a.content !== null ? `\n  content: ${JSON.stringify(a.content).slice(0, 40000)}` : ""}`)
        .join("\n")}`,
    );
  }
  if (request.availableTools.length) parts.push(`AVAILABLE TOOLS: ${request.availableTools.join(", ")}`);
  parts.push(
    useTool
      ? `Call the ${OUTPUT_TOOL_NAME} tool exactly once with the complete structured output. Do not respond with plain text.`
      : `Respond with a single JSON object that satisfies the "${request.requiredOutputSchema}" schema. No prose outside the JSON.`,
  );
  return parts.join("\n\n");
}

function usageOf(json: AnthropicMessage) {
  return { inputTokens: json.usage?.input_tokens ?? null, outputTokens: json.usage?.output_tokens ?? null };
}

function summarize(output: unknown, request: ProviderRequest): string {
  const summary = output && typeof output === "object" && typeof (output as { summary?: unknown }).summary === "string" ? (output as { summary: string }).summary : null;
  return summary ? summary.slice(0, 400) : `Claude produced a ${request.requiredOutputSchema} response.`;
}

/** Defence in depth: never let the key echo through an error message. */
function sanitize(text: string, apiKey: string | null): string {
  return apiKey ? text.split(apiKey).join("[redacted]") : text;
}

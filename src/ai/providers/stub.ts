/**
 * StubProvider — deterministic, network-free adapter used for local mode, tests and (only when
 * explicitly enabled) server-side dry runs. It returns the schema example for the requested output
 * so the job → validation → artifact → handoff pipeline is exercisable end to end.
 */
import type { ProviderCapability, ProviderId } from "@/data/types";
import { exampleFor } from "@/schemas/artifacts";
import { ProviderError, type AIProvider, type ProviderAvailability, type ProviderConnectionState, type ProviderRequest, type ProviderResponse } from "../types";

export interface StubProviderOptions {
  id: ProviderId;
  displayName?: string;
  capabilities?: ProviderCapability[];
  /** Simulated availability. Defaults to available. */
  available?: boolean;
  unavailableReason?: string;
  /** Make execute() throw — used to test fallback. */
  failWith?: string;
  /** Return output that does NOT satisfy the schema — used to test validation fallback. */
  invalidOutput?: boolean;
  /** How the provider presents in Settings. Defaults to "stub". */
  connectionState?: ProviderConnectionState;
}

export const DEFAULT_CAPABILITIES: Record<ProviderId, ProviderCapability[]> = {
  claude: ["text", "structured_output", "long_context", "vision", "code", "review"],
  openai: ["text", "structured_output", "vision", "code", "review"],
  gemini: ["text", "structured_output", "long_context", "vision", "review"],
};

export const PROVIDER_DISPLAY: Record<ProviderId, string> = { claude: "Claude", openai: "OpenAI", gemini: "Gemini" };

export class StubProvider implements AIProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapability[];
  readonly connected = false as const;
  readonly connectionState: ProviderConnectionState;
  private readonly available: boolean;
  private readonly unavailableReason: string;
  private readonly failWith?: string;
  private readonly invalidOutput: boolean;
  /** Requests seen — handy in tests. Never contains secrets. */
  readonly calls: ProviderRequest[] = [];

  constructor(opts: StubProviderOptions) {
    this.id = opts.id;
    this.displayName = opts.displayName ?? PROVIDER_DISPLAY[opts.id];
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES[opts.id];
    this.available = opts.available ?? true;
    this.unavailableReason = opts.unavailableReason ?? "provider marked unavailable";
    this.failWith = opts.failWith;
    this.invalidOutput = opts.invalidOutput ?? false;
    this.connectionState = opts.connectionState ?? "stub";
  }

  availability(): ProviderAvailability {
    return this.available ? { available: true } : { available: false, reason: this.unavailableReason };
  }

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    if (this.failWith) throw new ProviderError(this.id, this.failWith, "provider_error");
    const k = request.approvedKnowledge;
    const knowledgeCount = k.doctrine.length + k.agency.length + k.project.length + k.task.length;
    const output = this.invalidOutput ? { stub: true, note: "deliberately invalid output", schema: request.requiredOutputSchema } : exampleFor(request.requiredOutputSchema);
    return {
      providerId: this.id,
      model: null,
      output,
      summary: `[Stub · ${this.displayName}] No API is connected. ${request.agent.code} ${request.agent.name} (${request.taskType}) was routed here and a deterministic ${request.requiredOutputSchema} example was produced from ${request.inputArtifacts.length} input artifact(s) and ${knowledgeCount} approved knowledge item(s).`,
      usage: { inputTokens: null, outputTokens: null },
      finishReason: "stub",
    };
  }
}

/** Not-configured placeholder: registered so the router can record "skipped: not configured". */
export function notConfigured(id: ProviderId, envVar: string): StubProvider {
  return new StubProvider({ id, available: false, unavailableReason: `not configured (${envVar})`, connectionState: "not_configured" });
}

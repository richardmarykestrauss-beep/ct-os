/**
 * StubProvider — the Phase 1 adapter body shared by Claude, OpenAI and Gemini.
 *
 * It never calls a network. It returns a deterministic, clearly-labelled stub output so
 * the job → run → artifact → handoff pipeline can be exercised end to end. Real adapters
 * replace `execute` behind the same AIProvider interface in a later ticket.
 */
import type { ProviderCapability, ProviderId } from "@/data/types";
import { ProviderError, type AIProvider, type ProviderAvailability, type ProviderRequest, type ProviderResponse } from "../types";

export interface StubProviderOptions {
  id: ProviderId;
  displayName: string;
  capabilities: ProviderCapability[];
  /** Simulated availability. Defaults to available so the local pipeline runs. */
  available?: boolean;
  unavailableReason?: string;
  /** Make execute() throw — used to test fallback. */
  failWith?: string;
  /** Whether an API key is present in the environment (reported, never used). */
  configured?: boolean;
}

export class StubProvider implements AIProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapability[];
  readonly connected = false as const;
  readonly configured: boolean;
  private readonly available: boolean;
  private readonly unavailableReason: string;
  private readonly failWith?: string;
  /** Requests seen — handy in tests. */
  readonly calls: ProviderRequest[] = [];

  constructor(opts: StubProviderOptions) {
    this.id = opts.id;
    this.displayName = opts.displayName;
    this.capabilities = opts.capabilities;
    this.available = opts.available ?? true;
    this.unavailableReason = opts.unavailableReason ?? "provider marked unavailable";
    this.failWith = opts.failWith;
    this.configured = opts.configured ?? false;
  }

  availability(): ProviderAvailability {
    return this.available ? { available: true } : { available: false, reason: this.unavailableReason };
  }

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    if (this.failWith) throw new ProviderError(this.id, this.failWith);
    const summary = `[Stub · ${this.displayName}] No API is connected. Job ${request.jobId} for ${request.agentId} (${request.taskType}) was routed here and a placeholder ${request.requiredOutputSchema} output was produced from ${request.inputArtifacts.length} input artifact(s) and ${request.knowledge.length} knowledge item(s).`;
    return {
      providerId: this.id,
      model: null,
      output: {
        schema: request.requiredOutputSchema,
        stub: true,
        provider: this.id,
        inputArtifactIds: request.inputArtifacts.map((a) => a.id),
        knowledgeItemIds: request.knowledge.map((k) => k.id),
        note: "Placeholder output. Replace when the provider adapter is connected.",
      },
      summary,
      usage: { inputTokens: null, outputTokens: null },
      finishReason: "stub",
    };
  }
}

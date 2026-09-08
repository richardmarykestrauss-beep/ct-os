/**
 * Provider-neutral AI interfaces.
 *
 * CT-OS never depends on a provider SDK outside `src/ai/providers/*`. Agents own their
 * identity, permissions and artifacts; providers are interchangeable intelligence behind
 * these interfaces. Nothing in this module touches the network in Phase 1.
 */
import type { AgentJob, Artifact, KnowledgeItem, PermissionLevel, ProviderCapability, ProviderId } from "@/data/types";

export interface ProviderRequest {
  jobId: string;
  agentId: string;
  taskType: AgentJob["taskType"];
  /** Assembled system context: doctrine + approved agency/project knowledge + agent role. */
  systemContext: string;
  instructions: string;
  inputArtifacts: Artifact[];
  knowledge: KnowledgeItem[];
  /** e.g. "site_blueprint@1" */
  requiredOutputSchema: string;
  requiredCapabilities: ProviderCapability[];
  permissionLevel: PermissionLevel;
  availableToolIds: string[];
}

export interface ProviderResponse {
  providerId: ProviderId;
  /** Model identifier the adapter used; null for stubs. */
  model: string | null;
  /** Structured output intended to satisfy `requiredOutputSchema`. */
  output: unknown;
  /** Human-readable summary of the output for activity/run records. */
  summary: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  finishReason: "complete" | "stub" | "truncated" | "refused";
}

export type ProviderAvailability = { available: true } | { available: false; reason: string };

export interface AIProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapability[];
  /** True only when the adapter is wired to a real API. Stubs report false. */
  readonly connected: boolean;
  /** Whether a credential is present in the environment (reported, never used by stubs). */
  readonly configured?: boolean;
  availability(): Promise<ProviderAvailability> | ProviderAvailability;
  execute(request: ProviderRequest): Promise<ProviderResponse>;
}

export class ProviderError extends Error {
  constructor(
    readonly providerId: ProviderId,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class NoProviderAvailableError extends Error {
  constructor(
    readonly jobId: string,
    readonly attempts: RouterAttempt[],
  ) {
    super(`No provider could execute job ${jobId}: ${attempts.map((a) => `${a.providerId} (${a.outcome}${a.error ? `: ${a.error}` : ""})`).join("; ") || "no candidates"}`);
    this.name = "NoProviderAvailableError";
  }
}

export interface RouterAttempt {
  providerId: ProviderId;
  outcome: "succeeded" | "failed" | "skipped";
  /** Why a provider was skipped (missing capability, unavailable) or failed. */
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface RouterResult {
  providerId: ProviderId;
  response: ProviderResponse;
  attempts: RouterAttempt[];
}

export interface RoutingDecision {
  /** Ordered providers the router will try. */
  order: ProviderId[];
  /** Providers removed before trying, with reasons. */
  excluded: { providerId: ProviderId; reason: string }[];
}

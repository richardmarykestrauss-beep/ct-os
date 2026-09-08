/**
 * Provider-neutral execution contracts and AI interfaces.
 *
 * CT-OS never depends on a provider SDK outside `src/ai/providers/*`. Agents own their identity,
 * permissions, knowledge and artifacts; providers are interchangeable intelligence behind these
 * interfaces. The ExecutionRequest / ExecutionResult pair is the wire contract between the
 * frontend, the execution gateway and the ModelRouter — nothing provider-specific crosses it.
 */
import type { AgentTaskType, ArtifactType, ExecutionErrorCategory, PermissionLevel, ProviderCapability, ProviderId, ValidationResult } from "@/data/types";

// ---------------------------------------------------------------------------
// Execution envelope (Part C)
// ---------------------------------------------------------------------------

export interface ArtifactInput {
  id: string;
  type: ArtifactType;
  version: number;
  title: string;
  summary: string | null;
  /** Structured payload when present. Large payloads are the caller's responsibility to trim. */
  content: unknown;
}

export interface KnowledgeInput {
  id: string;
  title: string;
  content: string;
  category: string;
}

/** Only APPROVED knowledge, split by scope so prompts keep doctrine, agency patterns and project facts apart. */
export interface ApprovedKnowledge {
  doctrine: KnowledgeInput[];
  agency: KnowledgeInput[];
  project: KnowledgeInput[];
  task: KnowledgeInput[];
}

export interface ExecutionRequest {
  jobId: string;
  projectId: string;
  agentId: string;
  /** Stable agent identity — the same whichever provider executes. */
  agent: { code: string; name: string; role: string; responsibilities: string[] };
  taskType: AgentTaskType;
  instructions: string;
  inputArtifacts: ArtifactInput[];
  approvedKnowledge: ApprovedKnowledge;
  availableTools: string[];
  /** e.g. "site_blueprint@1" */
  requiredOutputSchema: string;
  schemaVersion: number;
  preferredProvider: ProviderId;
  fallbackProviders: ProviderId[];
  requiredCapabilities: ProviderCapability[];
  permissionLevel: PermissionLevel;
  requestedById: string | null;
}

// ---------------------------------------------------------------------------
// Result contract (Part D)
// ---------------------------------------------------------------------------

export type ExecutionStatus = "COMPLETED" | "FAILED" | "FAILED_VALIDATION" | "REJECTED";

export interface ExecutionError {
  category: ExecutionErrorCategory;
  message: string;
  /** Validation issues when category = validation. */
  issues?: ValidationResult["issues"];
}

export interface ExecutionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ExecutionResult {
  provider: ProviderId | null;
  model: string | null;
  runId: string | null;
  status: ExecutionStatus;
  /** Validated output (null unless COMPLETED). */
  output: unknown;
  outputSchema: string;
  schemaVersion: number;
  usage: ExecutionUsage;
  latencyMs: number | null;
  finishReason: FinishReason | null;
  error: ExecutionError | null;
  /** Every provider attempt, in policy order — never a silent switch. */
  attempts: RouterAttempt[];
}

export type FinishReason = "complete" | "stub" | "truncated" | "refused";

// ---------------------------------------------------------------------------
// Provider adapter interface
// ---------------------------------------------------------------------------

/** What an adapter receives: the neutral request plus the assembled system context. */
export interface ProviderRequest extends ExecutionRequest {
  systemContext: string;
  /** JSON Schema for the required output, for providers that accept one. */
  outputJsonSchema: Record<string, unknown> | null;
}

export interface ProviderResponse {
  providerId: ProviderId;
  /** Model identifier the adapter used; null for stubs. */
  model: string | null;
  /** Raw structured output — validated by the router before it becomes an artifact. */
  output: unknown;
  /** Human-readable summary for run records. */
  summary: string;
  usage: ExecutionUsage;
  finishReason: FinishReason;
}

export type ProviderAvailability = { available: true } | { available: false; reason: string };

export type ProviderConnectionState = "connected" | "not_configured" | "stub";

export interface AIProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapability[];
  /** True only when the adapter is wired to a real API with a credential present. */
  readonly connected: boolean;
  /** For Settings: connected / not_configured / stub. Never exposes the credential. */
  readonly connectionState: ProviderConnectionState;
  availability(): Promise<ProviderAvailability> | ProviderAvailability;
  execute(request: ProviderRequest): Promise<ProviderResponse>;
}

export class ProviderError extends Error {
  constructor(
    readonly providerId: ProviderId,
    message: string,
    readonly category: ExecutionErrorCategory = "provider_error",
    readonly retryable = true,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// ---------------------------------------------------------------------------
// Router records
// ---------------------------------------------------------------------------

export type AttemptOutcome = "succeeded" | "failed" | "failed_validation" | "skipped";

export interface RouterAttempt {
  providerId: ProviderId;
  outcome: AttemptOutcome;
  model: string | null;
  /** Why a provider was skipped or failed. */
  error?: string;
  errorCategory: ExecutionErrorCategory | null;
  validation: ValidationResult | null;
  usage: ExecutionUsage | null;
  latencyMs: number | null;
  /** Provider output when validation failed — kept for execution logs, never becomes an artifact. */
  rawOutput?: unknown;
  startedAt: string;
  finishedAt: string;
}

export interface RouterResult {
  providerId: ProviderId;
  response: ProviderResponse;
  /** Validated output (schema-parsed). */
  output: unknown;
  validation: ValidationResult;
  attempts: RouterAttempt[];
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

export interface RoutingDecision {
  order: ProviderId[];
  excluded: { providerId: ProviderId; reason: string }[];
}

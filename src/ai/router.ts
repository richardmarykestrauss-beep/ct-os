/**
 * ModelRouter — CT-OS decides which provider runs a job.
 *
 * Order of decision:
 *   1. preferred provider, then the fallback sequence (de-duplicated)
 *   2. remove providers that are disabled, lack a required capability, or report unavailable
 *   3. try the rest in order; after each provider answers, VALIDATE the output against the
 *      required schema — a response that fails validation counts as a failed attempt and the
 *      next provider is tried
 *   4. every skip / failure / validation failure / success is recorded as an attempt, in policy
 *      order, so execution history can show "Claude — failed validation · OpenAI — completed"
 * Cost/priority-based routing is `rank` (CTOS-003 Part F) — deterministic and explainable, see
 * ai/ranking.ts; each attempt carries the `selectionReason` bullets that produced its position.
 */
import type { ProviderId } from "@/data/types";
import { ProviderRegistry } from "./registry";
import { validateOutput } from "@/schemas/artifacts";
import { defaultRank, type RankedCandidate } from "./ranking";
import { NoProviderAvailableError, ProviderError, type AIProvider, type ExecutionRequest, type ProviderRequest, type RouterAttempt, type RouterResult, type RoutingDecision } from "./types";

type PlanRequest = Pick<ExecutionRequest, "preferredProvider" | "fallbackProviders" | "requiredCapabilities" | "executionPriority">;

export interface ModelRouterOptions {
  registry: ProviderRegistry;
  /** Deterministic, explainable ordering (CTOS-003 Part F). Defaults to ai/ranking.ts#defaultRank. */
  rank?: (candidates: AIProvider[], request: PlanRequest) => RankedCandidate[];
  /** Global provider allow-list (e.g. from Settings). Undefined = all. */
  enabledProviders?: ProviderId[];
  now?: () => string;
  clock?: () => number;
}

export class ModelRouter {
  private readonly registry: ProviderRegistry;
  private readonly rank: NonNullable<ModelRouterOptions["rank"]>;
  private readonly enabled?: Set<ProviderId>;
  private readonly now: () => string;
  private readonly clock: () => number;

  constructor(opts: ModelRouterOptions) {
    this.registry = opts.registry;
    this.rank = opts.rank ?? defaultRank;
    this.enabled = opts.enabledProviders ? new Set(opts.enabledProviders) : undefined;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.clock = opts.clock ?? (() => Date.now());
  }

  providers(): AIProvider[] {
    return this.registry.all();
  }

  status() {
    return this.registry.status();
  }

  /** Pure planning step — useful for the UI ("this job would run on …") and for tests. */
  async plan(request: PlanRequest): Promise<RoutingDecision> {
    const sequence = policySequence(request);
    const excluded: RoutingDecision["excluded"] = [];
    const candidates: AIProvider[] = [];
    for (const id of sequence) {
      const provider = this.registry.get(id);
      if (!provider) {
        excluded.push({ providerId: id, reason: "not registered" });
        continue;
      }
      if (this.enabled && !this.enabled.has(id)) {
        excluded.push({ providerId: id, reason: "disabled in settings" });
        continue;
      }
      const missing = request.requiredCapabilities.filter((c) => !provider.capabilities.includes(c));
      if (missing.length) {
        excluded.push({ providerId: id, reason: `missing capability: ${missing.join(", ")}` });
        continue;
      }
      const availability = await provider.availability();
      if (!availability.available) {
        excluded.push({ providerId: id, reason: availability.reason });
        continue;
      }
      candidates.push(provider);
    }
    const ranked = this.rank(candidates, request);
    const reasons: RoutingDecision["reasons"] = {};
    for (const r of ranked) reasons[r.provider.id] = r.reasons;
    return { order: ranked.map((r) => r.provider.id), excluded, reasons };
  }

  async execute(request: ProviderRequest): Promise<RouterResult> {
    const decision = await this.plan(request);
    const excluded = new Map(decision.excluded.map((e) => [e.providerId, e.reason]));
    const sequence = policySequence(request);
    const ranked = new Set(decision.order);
    const reasonText = (id: ProviderId): string | null => {
      const r = decision.reasons[id];
      return r ? r.map((x) => `+ ${x}`).join(" ") : null;
    };
    const attempts: RouterAttempt[] = [];
    for (const id of sequence) {
      if (excluded.has(id) || !ranked.has(id)) {
        const at = this.now();
        attempts.push({ providerId: id, outcome: "skipped", model: null, error: excluded.get(id) ?? "not selected", errorCategory: "provider_unavailable", validation: null, usage: null, latencyMs: null, selectionReason: null, startedAt: at, finishedAt: at });
      }
    }
    for (const id of decision.order) {
      const provider = this.registry.get(id)!;
      const selectionReason = reasonText(id);
      const startedAt = this.now();
      const t0 = this.clock();
      try {
        const response = await provider.execute(request);
        const latencyMs = this.clock() - t0;
        if (response.finishReason === "refused") {
          attempts.push({ providerId: id, outcome: "failed", model: response.model, error: response.summary, errorCategory: "provider_error", validation: null, usage: response.usage, latencyMs, selectionReason, startedAt, finishedAt: this.now() });
          continue;
        }
        const validation = validateOutput(request.requiredOutputSchema, response.output);
        if (!validation.ok) {
          attempts.push({
            providerId: id,
            outcome: "failed_validation",
            model: response.model,
            error: `Output failed ${request.requiredOutputSchema} validation: ${validation.issues
              .slice(0, 3)
              .map((i) => `${i.path}: ${i.message}`)
              .join("; ")}${validation.issues.length > 3 ? ` (+${validation.issues.length - 3} more)` : ""}`,
            errorCategory: "validation",
            validation: { ok: false, schema: validation.schema, issues: validation.issues },
            usage: response.usage,
            latencyMs,
            rawOutput: response.output,
            selectionReason,
            startedAt,
            finishedAt: this.now(),
          });
          continue;
        }
        attempts.push({ providerId: id, outcome: "succeeded", model: response.model, errorCategory: null, validation: { ok: true, schema: validation.schema, issues: [] }, usage: response.usage, latencyMs, selectionReason, startedAt, finishedAt: this.now() });
        return { providerId: id, response, output: validation.value, validation: { ok: true, schema: validation.schema, issues: [] }, attempts: orderAttempts(attempts, sequence) };
      } catch (err) {
        const category = err instanceof ProviderError ? err.category : "provider_error";
        attempts.push({ providerId: id, outcome: "failed", model: null, error: err instanceof Error ? err.message : String(err), errorCategory: category, validation: null, usage: null, latencyMs: this.clock() - t0, selectionReason, startedAt, finishedAt: this.now() });
      }
    }
    throw new NoProviderAvailableError(request.jobId, orderAttempts(attempts, sequence));
  }
}

function policySequence(request: Pick<ExecutionRequest, "preferredProvider" | "fallbackProviders">): ProviderId[] {
  return [request.preferredProvider, ...request.fallbackProviders].filter((id, i, arr) => arr.indexOf(id) === i);
}

/** Present attempts in policy order (skips interleaved where they occurred). */
function orderAttempts(attempts: RouterAttempt[], sequence: ProviderId[]): RouterAttempt[] {
  const index = new Map(sequence.map((id, i) => [id, i]));
  return [...attempts].sort((a, b) => (index.get(a.providerId) ?? 99) - (index.get(b.providerId) ?? 99));
}

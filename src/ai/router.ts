/**
 * ModelRouter — CT-OS decides which provider runs a job.
 *
 * Order of decision:
 *   1. preferred provider, then the job's fallback sequence (de-duplicated)
 *   2. remove providers that lack a required capability
 *   3. remove providers that report themselves unavailable
 *   4. try the rest in order; the first success wins, every attempt is recorded
 * Cost/priority-based routing is a later concern and has a reserved hook (`rank`).
 */
import type { AgentJob, ProviderId } from "@/data/types";
import { ProviderRegistry } from "./registry";
import { NoProviderAvailableError, type AIProvider, type ProviderRequest, type RouterAttempt, type RouterResult, type RoutingDecision } from "./types";
import { nowIso } from "@/lib/utils";

export interface ModelRouterOptions {
  registry: ProviderRegistry;
  /** Optional re-ordering hook for cost/priority routing later. Receives the filtered candidates. */
  rank?: (candidates: AIProvider[], job: AgentJob) => AIProvider[];
  /** Global provider allow-list (e.g. from Settings). Undefined = all. */
  enabledProviders?: ProviderId[];
}

export class ModelRouter {
  private readonly registry: ProviderRegistry;
  private readonly rank?: ModelRouterOptions["rank"];
  private readonly enabled?: Set<ProviderId>;

  constructor(opts: ModelRouterOptions) {
    this.registry = opts.registry;
    this.rank = opts.rank;
    this.enabled = opts.enabledProviders ? new Set(opts.enabledProviders) : undefined;
  }

  /** Registered providers, for Settings. */
  providers(): AIProvider[] {
    return this.registry.all();
  }

  /** Pure planning step — useful for the UI ("this job would run on …") and for tests. */
  async plan(job: AgentJob): Promise<RoutingDecision> {
    const sequence = [job.preferredProvider, ...job.fallbackProviders].filter((id, i, arr) => arr.indexOf(id) === i);
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
      const missing = job.requiredCapabilities.filter((c) => !provider.capabilities.includes(c));
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
    const ordered = this.rank ? this.rank(candidates, job) : candidates;
    return { order: ordered.map((p) => p.id), excluded };
  }

  async execute(job: AgentJob, request: ProviderRequest): Promise<RouterResult> {
    const decision = await this.plan(job);
    const excluded = new Map(decision.excluded.map((e) => [e.providerId, e.reason]));
    // Walk the policy sequence so recorded attempts read in the order CT-OS considered providers.
    const sequence = [job.preferredProvider, ...job.fallbackProviders].filter((id, i, arr) => arr.indexOf(id) === i);
    const ranked = new Set(decision.order);
    const attempts: RouterAttempt[] = [];
    for (const id of sequence) {
      if (excluded.has(id) || !ranked.has(id)) attempts.push({ providerId: id, outcome: "skipped", error: excluded.get(id) ?? "not selected", startedAt: nowIso(), finishedAt: nowIso() });
    }
    for (const id of decision.order) {
      const provider = this.registry.get(id)!;
      const startedAt = nowIso();
      try {
        const response = await provider.execute(request);
        attempts.push({ providerId: id, outcome: "succeeded", startedAt, finishedAt: nowIso() });
        return { providerId: id, response, attempts: orderAttempts(attempts, sequence) };
      } catch (err) {
        attempts.push({ providerId: id, outcome: "failed", error: err instanceof Error ? err.message : String(err), startedAt, finishedAt: nowIso() });
      }
    }
    throw new NoProviderAvailableError(job.id, orderAttempts(attempts, sequence));
  }
}

/** Present attempts in policy order (skips interleaved where they occurred), keeping any custom ranking order stable. */
function orderAttempts(attempts: RouterAttempt[], sequence: ProviderId[]): RouterAttempt[] {
  const index = new Map(sequence.map((id, i) => [id, i]));
  return [...attempts].sort((a, b) => (index.get(a.providerId) ?? 99) - (index.get(b.providerId) ?? 99));
}

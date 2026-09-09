/**
 * Deterministic, explainable provider ranking (CTOS-003 Part F).
 *
 * This is deliberately NOT a cost/latency optimiser. It is a transparent scoring pass over
 * candidates the router has already filtered to (a) have every capability the job requires and
 * (b) report themselves available right now. It never introduces a provider the job didn't ask
 * for — it only orders, and explains the order of, the agent's own preferred + fallback sequence.
 * Every score contribution is listed in `reasons` so execution history can show, verbatim, why a
 * provider was picked — e.g. "Selected Claude because: + preferred provider for this job +
 * structured_output capability + reasoning capability (favoured by QUALITY priority)".
 */
import type { ExecutionPriority, ProviderCapability, ProviderId } from "@/data/types";
import type { AIProvider, ExecutionRequest } from "./types";

export interface RankedCandidate {
  provider: AIProvider;
  score: number;
  reasons: string[];
}

/**
 * Illustrative relative cost/speed tiers (1 = cheapest/fastest), used only to break ties under
 * COST/SPEED priority. NOT live pricing — see src/ai/pricing.ts for the (equally illustrative,
 * equally revisable) cost-per-token config. Kept in one small table so revising the heuristic
 * never means touching the scoring logic itself.
 */
const COST_TIER: Record<ProviderId, number> = { gemini: 1, openai: 2, claude: 3 };
const SPEED_TIER: Record<ProviderId, number> = { gemini: 1, openai: 1, claude: 2 };

const PRIORITY_BONUS_CAPABILITIES: Record<ExecutionPriority, ProviderCapability[]> = {
  QUALITY: ["reasoning", "long_context"],
  BALANCED: ["structured_output"],
  COST: [],
  SPEED: ["fast_generation"],
};

/**
 * Score and order candidates. Ties keep the caller's original (policy) order, so with no
 * differentiator at all — e.g. two candidates with identical capabilities under BALANCED — the
 * preferred-then-fallback sequence the agent was configured with is exactly what comes out.
 */
export function rankCandidates(candidates: AIProvider[], request: Pick<ExecutionRequest, "preferredProvider" | "requiredCapabilities" | "executionPriority">): RankedCandidate[] {
  const priority: ExecutionPriority = request.executionPriority ?? "BALANCED";
  const scored = candidates.map((provider, index) => {
    const reasons: string[] = [];
    let score = 0;
    if (provider.id === request.preferredProvider) {
      score += 10;
      reasons.push("preferred provider for this job");
    } else {
      reasons.push(`fallback (position ${index + 1} in the policy sequence)`);
    }
    for (const cap of request.requiredCapabilities) reasons.push(`${cap} capability`);
    for (const cap of PRIORITY_BONUS_CAPABILITIES[priority]) {
      if (provider.capabilities.includes(cap) && !request.requiredCapabilities.includes(cap)) {
        score += 2;
        reasons.push(`${cap} capability (favoured by ${priority} priority)`);
      }
    }
    if (priority === "COST") {
      score += (4 - COST_TIER[provider.id]) * 2;
      reasons.push(`cost tier ${COST_TIER[provider.id]} of 3, lower favoured by COST priority`);
    }
    if (priority === "SPEED") {
      score += (3 - SPEED_TIER[provider.id]) * 2;
      reasons.push(`speed tier ${SPEED_TIER[provider.id]} of 2, lower favoured by SPEED priority`);
    }
    reasons.push("available");
    return { provider, score, reasons, index };
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map(({ provider, score, reasons }) => ({ provider, score, reasons }));
}

/** Default `rank` hook for ModelRouter — see ai/router.ts. Exposed separately so a caller can override with a different (still explainable) strategy without losing this one as a reference. */
export const defaultRank = rankCandidates;

export function explainSelection(providerId: ProviderId, ranked: RankedCandidate[]): string {
  const entry = ranked.find((r) => r.provider.id === providerId);
  if (!entry) return `Selected ${providerId}.`;
  return `Selected ${entry.provider.displayName} because: ${entry.reasons.map((r) => `+ ${r}`).join(" ")}`;
}

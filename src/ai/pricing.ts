/**
 * Provider pricing config (CTOS-003 Part G).
 *
 * Prices are NOT hardcoded into usage-recording or routing logic — they live here, in one
 * versioned table, precisely so they can be revised without touching business logic. Usage
 * recording (input/output/total tokens, provider, model) is always captured when a provider
 * returns it; cost estimation is optional and stays null whenever the model isn't in this table —
 * CT-OS never guesses a price. These figures are illustrative publicly-listed rates as of the
 * `effectiveDate` given and WILL go stale; treat them as a starting point to keep current
 * operationally, not as a billing source of truth.
 */
import type { ProviderId } from "@/data/types";

export interface PricingEntry {
  provider: ProviderId;
  model: string;
  /** ISO date this rate took effect. When several entries match, the most recent one <= now wins. */
  effectiveDate: string;
  /** USD per 1,000,000 input tokens. */
  inputPerMillionUsd: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMillionUsd: number;
}

export const PRICING_TABLE: PricingEntry[] = [
  { provider: "openai", model: "gpt-4o-mini", effectiveDate: "2024-07-18", inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  { provider: "claude", model: "claude-3-5-haiku-20241022", effectiveDate: "2024-10-22", inputPerMillionUsd: 0.8, outputPerMillionUsd: 4.0 },
  { provider: "claude", model: "claude-3-5-sonnet-20241022", effectiveDate: "2024-10-22", inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0 },
  { provider: "gemini", model: "gemini-1.5-flash", effectiveDate: "2024-05-14", inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 },
];

/** Picks the entry effective at `at` (default now) for an exact provider+model match. Null when unknown — never a guess. */
export function findPricing(provider: ProviderId, model: string | null, at: string = new Date().toISOString()): PricingEntry | null {
  if (!model) return null;
  const candidates = PRICING_TABLE.filter((p) => p.provider === provider && p.model === model && p.effectiveDate <= at);
  if (!candidates.length) return null;
  return candidates.reduce((best, p) => (p.effectiveDate > best.effectiveDate ? p : best));
}

/** inputTokens + outputTokens when at least one is a known number; null when both are unknown. */
export function totalTokensOf(usage: { inputTokens: number | null; outputTokens: number | null } | null | undefined): number | null {
  if (!usage) return null;
  if (usage.inputTokens === null && usage.outputTokens === null) return null;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/** Null whenever pricing for this provider+model isn't known — cost estimation is always optional. */
export function estimateCostUsd(provider: ProviderId, model: string | null, usage: { inputTokens: number | null; outputTokens: number | null } | null | undefined): number | null {
  const pricing = findPricing(provider, model);
  if (!pricing || !usage) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return (input / 1_000_000) * pricing.inputPerMillionUsd + (output / 1_000_000) * pricing.outputPerMillionUsd;
}

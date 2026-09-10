/**
 * Capability safety registry (CTOS-005A Part 13).
 *
 * Single source of truth for provider capabilities, agent requirements, and router checks.
 * Replaces ad-hoc string comparisons; unknown capability strings are rejected at compile time.
 *
 * The benchmark exposed an "seo" vs "long_context" mismatch — this registry prevents
 * that class of error by ensuring every consumer references the same typed enum.
 */
import type { ProviderCapability, ProviderId } from "@/data/types";
import { DEFAULT_CAPABILITIES } from "@/ai/providers/stub";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Human-readable descriptions for every capability in the type union. */
export const CAPABILITY_DESCRIPTIONS: Record<ProviderCapability, string> = {
  text: "Plain text generation",
  structured_output: "JSON / tool-call structured output",
  long_context: "200k+ token context window",
  vision: "Image and screenshot understanding",
  code: "Code generation, review, and explanation",
  review: "Quality evaluation and critique",
  reasoning: "Multi-step chain-of-thought reasoning",
  fast_generation: "Optimised for low latency",
  creative_generation: "Copy, naming, creative direction",
};

/** All valid capability strings — the canonical list derived from the type. */
export const ALL_CAPABILITIES = Object.keys(CAPABILITY_DESCRIPTIONS) as ProviderCapability[];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Return true when the string is a known ProviderCapability. */
export function isKnownCapability(cap: string): cap is ProviderCapability {
  return cap in CAPABILITY_DESCRIPTIONS;
}

/**
 * Assert that every string in the array is a known capability.
 * Throws if any unknown capability is found — fails closed.
 */
export function assertKnownCapabilities(caps: string[]): asserts caps is ProviderCapability[] {
  const unknown = caps.filter((c) => !isKnownCapability(c));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown capabilities: ${unknown.join(", ")}. Valid capabilities: ${ALL_CAPABILITIES.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Provider capability check
// ---------------------------------------------------------------------------

/** Return whether a provider satisfies all required capabilities. */
export function providerSatisfies(
  providerId: ProviderId,
  required: ProviderCapability[],
  overrides?: Partial<Record<ProviderId, ProviderCapability[]>>,
): boolean {
  const providerCaps = new Set(overrides?.[providerId] ?? DEFAULT_CAPABILITIES[providerId] ?? []);
  return required.every((c) => providerCaps.has(c));
}

/**
 * Select the first provider from the ordered list that satisfies all required capabilities.
 * Returns null when no provider satisfies them — the job must go to NEEDS_A_HAND.
 */
export function selectCapableProvider(
  ordered: ProviderId[],
  required: ProviderCapability[],
  overrides?: Partial<Record<ProviderId, ProviderCapability[]>>,
): ProviderId | null {
  return ordered.find((p) => providerSatisfies(p, required, overrides)) ?? null;
}

/**
 * Return a diagnostic explaining why no provider satisfies the requirements.
 * Used in NEEDS_A_HAND error messages and attention queue items.
 */
export function capabilityGapDiagnostic(
  required: ProviderCapability[],
  providers: ProviderId[],
  overrides?: Partial<Record<ProviderId, ProviderCapability[]>>,
): string {
  const lines: string[] = [`No provider satisfies required capabilities: [${required.join(", ")}]`];
  for (const p of providers) {
    const has = new Set(overrides?.[p] ?? DEFAULT_CAPABILITIES[p] ?? []);
    const missing = required.filter((c) => !has.has(c));
    if (missing.length > 0) lines.push(`  ${p}: missing [${missing.join(", ")}]`);
    else lines.push(`  ${p}: satisfies all`);
  }
  return lines.join("\n");
}

/**
 * Provider circuit breaker (CTOS-005A Part 11).
 *
 * Conservative policy: preferred → compatible fallback → NEEDS_A_HAND.
 * Does NOT hammer a failing provider. Recognises quota, credit, HTTP 429,
 * repeated 503, unavailable, retired model, and authentication errors.
 *
 * Provider health records temporary state only — uses HealthTracker from
 * the existing adapter layer (src/ai/providers/health.ts) as the state store.
 * This module adds typed circuit state mapping and the no-rerun-after-manual guarantee.
 */
import type { ProviderId } from "@/data/types";
import type { ProviderCircuitState } from "@/data/types";
import type { ExecutionErrorCategory } from "@/data/types";

/** Map provider error categories + HTTP status to a typed circuit state. */
export function errorToCircuitState(
  category: ExecutionErrorCategory,
  httpStatus: number | null,
): ProviderCircuitState {
  if (category === "config") return "not_configured";
  if (category === "provider_unavailable") {
    if (httpStatus === 429) return "rate_limited";
    if (httpStatus === 402) return "quota_exceeded";
    if (httpStatus !== null && httpStatus >= 500) return "unavailable";
    return "unavailable";
  }
  if (category === "provider_error") return "degraded";
  if (category === "auth") return "not_configured";
  return "degraded";
}

/**
 * Routing policy for the circuit breaker (Part 11).
 * Called after all attempts have been recorded to decide the next step.
 *
 * Returns:
 *  - "continue": try the next provider in the fallback list
 *  - "needs_a_hand": all providers exhausted / circuit open → Mode B/C
 */
export function circuitBreakerDecision(
  providers: { id: ProviderId; state: ProviderCircuitState }[],
  alreadyAttempted: Set<ProviderId>,
): "continue" | "needs_a_hand" {
  const remaining = providers.filter(
    (p) => !alreadyAttempted.has(p.id) && p.state !== "not_configured" && p.state !== "unavailable" && p.state !== "quota_exceeded",
  );
  return remaining.length > 0 ? "continue" : "needs_a_hand";
}

/**
 * Never rerun after manual completion.
 * A job that completed via Mode B or C must not be automatically re-executed
 * when a provider recovers. This check guards the gateway/executor before any auto-retry.
 */
export function isManuallyCompleted(executionMode: string | undefined): boolean {
  return executionMode === "B" || executionMode === "C";
}

/** HTTP status codes that indicate quota/billing exhaustion (not temporary rate limiting). */
export const QUOTA_EXHAUSTED_STATUSES = new Set([402, 429]);

/** HTTP status codes that indicate transient provider unavailability. */
export const TRANSIENT_ERROR_STATUSES = new Set([500, 502, 503, 504]);

/**
 * Returns true when a provider error is retryable (transient) vs permanent (circuit-open).
 * Permanent errors: auth failures, config errors, retired/unknown model.
 * Transient errors: rate limits (with backoff), 5xx.
 */
export function isRetryableError(category: ExecutionErrorCategory, httpStatus: number | null): boolean {
  if (category === "config" || category === "auth") return false;
  if (httpStatus !== null && QUOTA_EXHAUSTED_STATUSES.has(httpStatus)) return false;
  if (category === "provider_unavailable" || (httpStatus !== null && TRANSIENT_ERROR_STATUSES.has(httpStatus))) return true;
  if (category === "validation") return true; // may succeed with a repair instruction
  return false;
}

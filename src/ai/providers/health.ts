/**
 * Shared health tracking for live provider adapters (CTOS-003 Part N).
 *
 * Each live adapter (OpenAI, Claude, Gemini) owns one of these. It never holds a credential or
 * any request/response content — only the category and HTTP status of the adapter's most recent
 * failure, and when it happened, so `connectionState` can report rate_limited / degraded /
 * unavailable instead of a flat "connected" that hides a provider that is currently failing.
 */
import type { ExecutionErrorCategory } from "@/data/types";
import type { ProviderConnectionState } from "../types";

export interface HealthTrackerOptions {
  /** How long a recorded failure keeps affecting connectionState/availability. Default 60s. */
  cooldownMs?: number;
  /** Injectable clock for tests. */
  clock?: () => number;
}

export class HealthTracker {
  private readonly cooldownMs: number;
  private readonly clock: () => number;
  private lastFailure: { category: ExecutionErrorCategory; httpStatus: number | null; at: number } | null = null;

  constructor(opts: HealthTrackerOptions = {}) {
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.clock = opts.clock ?? (() => Date.now());
  }

  recordFailure(category: ExecutionErrorCategory, httpStatus: number | null) {
    this.lastFailure = { category, httpStatus, at: this.clock() };
  }

  recordSuccess() {
    this.lastFailure = null;
  }

  private activeFailure() {
    if (!this.lastFailure) return null;
    return this.clock() - this.lastFailure.at < this.cooldownMs ? this.lastFailure : null;
  }

  /** `connected`/`not_configured`/`disabled` are the caller's to decide (credential + policy); this only ever returns the failure-derived states, or null when nothing recent is wrong. */
  state(): Extract<ProviderConnectionState, "rate_limited" | "degraded" | "unavailable"> | null {
    const f = this.activeFailure();
    if (!f) return null;
    if (f.httpStatus === 429) return "rate_limited";
    if (f.category === "config") return "unavailable"; // credential present but rejected (401/403)
    if (f.category === "provider_unavailable") return "degraded"; // 5xx / network, non-429
    return null;
  }

  /** Whether the tracked failure should currently block execution (rate limit and invalid-credential both should; a generic 5xx blip degrades but the router may still try it). */
  blocksAvailability(): boolean {
    const s = this.state();
    return s === "rate_limited" || s === "unavailable";
  }

  reason(): string | null {
    const f = this.activeFailure();
    if (!f) return null;
    const s = this.state();
    if (s === "rate_limited") return "rate limited — cooling down";
    if (s === "unavailable") return "credential rejected by the provider";
    if (s === "degraded") return "recent provider error — degraded";
    return null;
  }
}

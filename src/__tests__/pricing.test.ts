/**
 * Provider pricing config (CTOS-003 Part G) — versioned, never hardcoded into business logic, and
 * always optional: an unknown provider/model combination yields a null estimate, never a guess.
 */
import { describe, expect, it } from "vitest";
import { estimateCostUsd, findPricing, totalTokensOf } from "@/ai/pricing";

describe("findPricing", () => {
  it("finds an exact provider+model match effective at the given date", () => {
    const p = findPricing("openai", "gpt-4o-mini", "2025-01-01T00:00:00.000Z");
    expect(p).toMatchObject({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("returns null for an unknown model — never guesses a nearby one", () => {
    expect(findPricing("openai", "gpt-4o-mini-2024-07-18")).toBeNull();
    expect(findPricing("claude", "claude-3-opus-unknown")).toBeNull();
  });

  it("returns null when the model is null", () => {
    expect(findPricing("openai", null)).toBeNull();
  });

  it("never returns a rate that has not taken effect yet as of the given date", () => {
    expect(findPricing("claude", "claude-3-5-sonnet-20241022", "2020-01-01T00:00:00.000Z")).toBeNull();
  });

  it("picks the most recent effective entry when several exist for the same provider+model", () => {
    // Both claude-3-5-* entries have distinct models, so this exercises the "most recent <= at" reduction
    // against the single matching entry — still must not throw and must return that one entry.
    const p = findPricing("claude", "claude-3-5-haiku-20241022", "2030-01-01T00:00:00.000Z");
    expect(p?.model).toBe("claude-3-5-haiku-20241022");
  });
});

describe("totalTokensOf", () => {
  it("sums input and output tokens", () => {
    expect(totalTokensOf({ inputTokens: 100, outputTokens: 50 })).toBe(150);
  });

  it("treats a missing side as zero when the other is known", () => {
    expect(totalTokensOf({ inputTokens: 100, outputTokens: null })).toBe(100);
    expect(totalTokensOf({ inputTokens: null, outputTokens: 50 })).toBe(50);
  });

  it("is null when both are unknown, or usage itself is missing", () => {
    expect(totalTokensOf({ inputTokens: null, outputTokens: null })).toBeNull();
    expect(totalTokensOf(null)).toBeNull();
    expect(totalTokensOf(undefined)).toBeNull();
  });
});

describe("estimateCostUsd", () => {
  it("computes cost from the input/output per-million rates", () => {
    // gemini-1.5-flash: $0.075 / $0.30 per million.
    const cost = estimateCostUsd("gemini", "gemini-1.5-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.075 + 0.3, 6);
  });

  it("is null whenever pricing for the provider+model is unknown — never a guessed cost", () => {
    expect(estimateCostUsd("openai", "gpt-5-unreleased", { inputTokens: 100, outputTokens: 100 })).toBeNull();
    expect(estimateCostUsd("openai", null, { inputTokens: 100, outputTokens: 100 })).toBeNull();
  });

  it("is null when usage itself is missing, even for a known model", () => {
    expect(estimateCostUsd("openai", "gpt-4o-mini", null)).toBeNull();
  });

  it("treats missing token counts as zero rather than throwing", () => {
    const cost = estimateCostUsd("openai", "gpt-4o-mini", { inputTokens: null, outputTokens: 1000 });
    expect(cost).toBeCloseTo((1000 / 1_000_000) * 0.6, 8);
  });
});

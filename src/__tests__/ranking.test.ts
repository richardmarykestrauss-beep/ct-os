/**
 * Deterministic, explainable provider ranking (CTOS-003 Part F). Not a black-box optimiser: every
 * assertion here is about the ORDER and the human-readable REASONS a candidate was placed there.
 */
import { describe, expect, it } from "vitest";
import { explainSelection, rankCandidates } from "@/ai/ranking";
import { StubProvider } from "@/ai/providers/stub";
import type { ExecutionRequest } from "@/ai/types";

type Req = Pick<ExecutionRequest, "preferredProvider" | "requiredCapabilities" | "executionPriority">;

function req(overrides: Partial<Req> = {}): Req {
  return { preferredProvider: "claude", requiredCapabilities: ["text", "structured_output"], executionPriority: "BALANCED", ...overrides };
}

describe("rankCandidates", () => {
  it("scores the preferred provider highest and explains why, listing every required capability", () => {
    const claude = new StubProvider({ id: "claude" });
    const openai = new StubProvider({ id: "openai" });
    const ranked = rankCandidates([claude, openai], req());
    expect(ranked[0].provider.id).toBe("claude");
    expect(ranked[0].reasons).toContain("preferred provider for this job");
    expect(ranked[0].reasons).toContain("text capability");
    expect(ranked[0].reasons).toContain("structured_output capability");
    expect(ranked[1].reasons[0]).toMatch(/^fallback \(position 2 in the policy sequence\)$/);
  });

  it("keeps the caller's policy order as a stable tiebreak when nothing else differentiates candidates", () => {
    const gemini = new StubProvider({ id: "gemini" });
    const openai = new StubProvider({ id: "openai" });
    // Neither is preferred; BALANCED bonus (structured_output) is already required so it adds nothing extra.
    const ranked = rankCandidates([gemini, openai], req({ preferredProvider: "claude", requiredCapabilities: ["structured_output"] }));
    expect(ranked.map((r) => r.provider.id)).toEqual(["gemini", "openai"]);
    expect(ranked[0].score).toBe(ranked[1].score);
  });

  it("QUALITY priority favours reasoning/long_context capability among otherwise-equal candidates", () => {
    const claude = new StubProvider({ id: "claude", capabilities: ["text", "structured_output", "reasoning", "long_context"] });
    const openai = new StubProvider({ id: "openai", capabilities: ["text", "structured_output"] });
    const ranked = rankCandidates([openai, claude], req({ preferredProvider: "gemini", requiredCapabilities: ["text", "structured_output"], executionPriority: "QUALITY" }));
    expect(ranked[0].provider.id).toBe("claude");
    expect(ranked[0].reasons.some((r) => r.includes("reasoning capability (favoured by QUALITY priority)"))).toBe(true);
    expect(ranked[0].reasons.some((r) => r.includes("long_context capability (favoured by QUALITY priority)"))).toBe(true);
    // Already-required capabilities never get double-counted as a "favoured by" bonus reason.
    expect(ranked[0].reasons.some((r) => /^text capability \(favoured/.test(r))).toBe(false);
  });

  it("does not double-count a capability that is both required and priority-favoured", () => {
    const claude = new StubProvider({ id: "claude", capabilities: ["text", "structured_output", "reasoning"] });
    const openai = new StubProvider({ id: "openai", capabilities: ["text", "structured_output", "reasoning"] });
    const ranked = rankCandidates([claude, openai], req({ preferredProvider: "gemini", requiredCapabilities: ["text", "structured_output", "reasoning"], executionPriority: "QUALITY" }));
    // Both candidates have identical (required) capabilities and neither is preferred → tie, policy order kept.
    expect(ranked[0].score).toBe(ranked[1].score);
    expect(ranked.every((r) => !r.reasons.some((x) => x.includes("favoured by QUALITY")))).toBe(true);
  });

  it("COST priority favours the cheaper tier (gemini < openai < claude)", () => {
    const claude = new StubProvider({ id: "claude" });
    const gemini = new StubProvider({ id: "gemini" });
    const ranked = rankCandidates([claude, gemini], req({ preferredProvider: "openai", executionPriority: "COST" }));
    expect(ranked[0].provider.id).toBe("gemini");
    expect(ranked[0].reasons.some((r) => r.includes("cost tier"))).toBe(true);
  });

  it("SPEED priority favours the faster tier (gemini/openai < claude)", () => {
    const claude = new StubProvider({ id: "claude" });
    const openai = new StubProvider({ id: "openai" });
    const ranked = rankCandidates([claude, openai], req({ preferredProvider: "gemini", executionPriority: "SPEED" }));
    expect(ranked[0].provider.id).toBe("openai");
    expect(ranked[0].reasons.some((r) => r.includes("speed tier"))).toBe(true);
  });

  it("defaults to BALANCED when executionPriority is omitted", () => {
    const claude = new StubProvider({ id: "claude" });
    const ranked = rankCandidates([claude], { preferredProvider: "claude", requiredCapabilities: [], executionPriority: undefined as unknown as Req["executionPriority"] });
    expect(ranked[0].provider.id).toBe("claude");
  });
});

describe("explainSelection", () => {
  it("renders a human-readable, verbatim-storable reasoning string", () => {
    const claude = new StubProvider({ id: "claude" });
    const openai = new StubProvider({ id: "openai" });
    const ranked = rankCandidates([claude, openai], req());
    const text = explainSelection("claude", ranked);
    expect(text).toMatch(/^Selected Claude because: \+ preferred provider for this job \+ text capability \+ structured_output capability \+ available$/);
  });

  it("falls back to a minimal string for a provider id the ranking never saw", () => {
    expect(explainSelection("gemini", [])).toBe("Selected gemini.");
  });
});

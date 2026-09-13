import { describe, expect, it } from "vitest";
import { seedData } from "@/data/seed";
import { ModelRouter } from "@/ai/router";
import { ProviderRegistry } from "@/ai/registry";
import { StubProvider } from "@/ai/providers/stub";
const ClaudeProvider = (opts: Partial<ConstructorParameters<typeof StubProvider>[0]> = {}) => new StubProvider({ id: "claude", ...opts });
const OpenAIProvider = (opts: Partial<ConstructorParameters<typeof StubProvider>[0]> = {}) => new StubProvider({ id: "openai", ...opts });
const GeminiProvider = (opts: Partial<ConstructorParameters<typeof StubProvider>[0]> = {}) => new StubProvider({ id: "gemini", ...opts });
import { NoProviderAvailableError } from "@/ai/types";
import { buildProviderRequest, createJob, executeJob } from "@/services/agent-jobs";

const base = () => structuredClone(seedData);

function jobFor(agentId: string) {
  const { data, job } = createJob(base(), { projectId: "proj_uproof", agentId, instructions: "test" });
  return { data, job, request: buildProviderRequest(data, job) };
}

describe("model router", () => {
  it("uses the preferred provider when it is available", async () => {
    const claude = ClaudeProvider();
    const router = new ModelRouter({ registry: new ProviderRegistry([claude, OpenAIProvider(), GeminiProvider()]) });
    const { request } = jobFor("agent_02"); // prefers claude
    const result = await router.execute(request);
    expect(result.providerId).toBe("claude");
    expect(claude.calls.length).toBe(1);
    expect(result.attempts).toEqual([expect.objectContaining({ providerId: "claude", outcome: "succeeded", validation: expect.objectContaining({ ok: true }) })]);
  });

  it("falls back in sequence when the preferred provider fails", async () => {
    const claude = ClaudeProvider({ failWith: "rate limited" });
    const openai = OpenAIProvider();
    const router = new ModelRouter({ registry: new ProviderRegistry([claude, openai, GeminiProvider()]) });
    const { request } = jobFor("agent_02"); // claude → openai
    const result = await router.execute(request);
    expect(result.providerId).toBe("openai");
    expect(result.attempts.map((a) => [a.providerId, a.outcome])).toEqual([
      ["claude", "failed"],
      ["openai", "succeeded"],
    ]);
    expect(result.attempts[0].errorCategory).toBe("provider_error");
    expect(result.attempts[0].error).toBe("rate limited");
  });

  it("skips unavailable providers before trying them", async () => {
    const router = new ModelRouter({ registry: new ProviderRegistry([ClaudeProvider({ available: false, unavailableReason: "no key" }), OpenAIProvider(), GeminiProvider()]) });
    const { request } = jobFor("agent_02");
    const plan = await router.plan(request);
    expect(plan.order).toEqual(["openai"]);
    expect(plan.excluded).toEqual([{ providerId: "claude", reason: "no key" }]);
  });

  it("filters providers that lack a required capability", async () => {
    // Agent 03 needs vision; give OpenAI no vision capability.
    const openai = OpenAIProvider({ capabilities: ["text", "structured_output"] });
    const router = new ModelRouter({ registry: new ProviderRegistry([ClaudeProvider({ failWith: "down" }), openai, GeminiProvider()]) });
    const { request } = jobFor("agent_03"); // claude → openai → gemini
    const result = await router.execute(request);
    expect(result.providerId).toBe("gemini");
    expect(result.attempts.map((a) => a.providerId + ":" + a.outcome)).toEqual(["claude:failed", "openai:skipped", "gemini:succeeded"]);
  });

  it("throws NoProviderAvailableError with every attempt when all fail, and executeJob records a FAILED job", async () => {
    const router = new ModelRouter({ registry: new ProviderRegistry([ClaudeProvider({ failWith: "a" }), OpenAIProvider({ failWith: "b" })]) });
    const { data, job, request } = jobFor("agent_02");
    await expect(router.execute(request)).rejects.toBeInstanceOf(NoProviderAvailableError);
    const outcome = await executeJob(data, job.id, router);
    expect(outcome.job.status).toBe("FAILED");
    expect(outcome.job.error).toMatch(/claude \(failed: a\); openai \(failed: b\)/);
    expect(outcome.runs.map((r) => r.status)).toEqual(["FAILED", "FAILED"]);
    expect(outcome.artifactId).toBeNull();
  });

  it("respects a settings-level provider allow-list", async () => {
    const router = new ModelRouter({ registry: new ProviderRegistry([ClaudeProvider(), OpenAIProvider(), GeminiProvider()]), enabledProviders: ["openai"] });
    const { request } = jobFor("agent_02");
    const plan = await router.plan(request);
    expect(plan.order).toEqual(["openai"]);
    expect(plan.excluded[0]).toEqual({ providerId: "claude", reason: "disabled in settings" });
  });

  // CTOS-008M: production observed A06 (the only agent whose PREFERRED provider is openai — A01-A04
  // all prefer claude/gemini and only ever list openai as a fallback) repeatedly stuck QUEUED while
  // OpenAI was unconfigured. These prove the router itself resolves availability BEFORE executing —
  // an unavailable preferred provider is recorded as "skipped" and never attempted, exactly like any
  // other excluded candidate — so if A06 really was stuck on this, the bug is not here.
  describe("CTOS-008M: A06's real policy (preferred openai, fallbacks claude → gemini)", () => {
    it("OpenAI unavailable, Claude available: Claude runs, OpenAI is skipped (not attempted, not a failure), job leaves QUEUED for a real terminal outcome", async () => {
      const openai = OpenAIProvider({ available: false, unavailableReason: "not configured (OPENAI_API_KEY)" });
      const claude = ClaudeProvider();
      const router = new ModelRouter({ registry: new ProviderRegistry([openai, claude, GeminiProvider()]) });
      const { data, job, request } = jobFor("agent_06");
      expect(job.preferredProvider).toBe("openai");
      expect(job.fallbackProviders).toEqual(["claude", "gemini"]);
      const result = await router.execute(request);
      expect(result.providerId).toBe("claude");
      expect(claude.calls.length).toBe(1);
      expect(result.attempts.map((a) => [a.providerId, a.outcome])).toEqual([
        ["openai", "skipped"],
        ["claude", "succeeded"],
      ]);
      expect(result.attempts[0].error).toBe("not configured (OPENAI_API_KEY)");
      expect(result.attempts[0].errorCategory).toBe("provider_unavailable");
      // Success reaches WAITING_APPROVAL here (executeJob is the pure per-job step; the audit
      // pipeline's own AUDIT_JOB_SETTLE auto-approves a GREEN agent like A06 the rest of the way to
      // COMPLETED — see audit-orchestration.test.ts for that full path). The point proven here is
      // that it advances past QUEUED at all, on Claude, without OpenAI's absence blocking it.
      const outcome = await executeJob(data, job.id, router);
      expect(outcome.job.status).toBe("WAITING_APPROVAL");
      expect(outcome.artifactId).toBeTruthy();
    });

    it("OpenAI and Claude unavailable, Gemini available: Gemini runs", async () => {
      const openai = OpenAIProvider({ available: false, unavailableReason: "not configured (OPENAI_API_KEY)" });
      const claude = ClaudeProvider({ available: false, unavailableReason: "not configured (ANTHROPIC_API_KEY)" });
      const gemini = GeminiProvider();
      const router = new ModelRouter({ registry: new ProviderRegistry([openai, claude, gemini]) });
      const { request } = jobFor("agent_06");
      const result = await router.execute(request);
      expect(result.providerId).toBe("gemini");
      expect(gemini.calls.length).toBe(1);
      expect(result.attempts.map((a) => [a.providerId, a.outcome])).toEqual([
        ["openai", "skipped"],
        ["claude", "skipped"],
        ["gemini", "succeeded"],
      ]);
    });

    it("all three unavailable: explicit terminal state (never left QUEUED/RUNNING), OpenAI absence recorded as unavailable, not a generic error", async () => {
      const router = new ModelRouter({
        registry: new ProviderRegistry([
          OpenAIProvider({ available: false, unavailableReason: "not configured (OPENAI_API_KEY)" }),
          ClaudeProvider({ available: false, unavailableReason: "not configured (ANTHROPIC_API_KEY)" }),
          GeminiProvider({ available: false, unavailableReason: "not configured (GEMINI_API_KEY)" }),
        ]),
      });
      const { data, job, request } = jobFor("agent_06");
      await expect(router.execute(request)).rejects.toBeInstanceOf(NoProviderAvailableError);
      // 3 providers all skipped = 3 total attempts, which meets MAX_AUTO_RETRY_ATTEMPTS (3) — this
      // is the same "exhaustion is actionable, not silent" rule gateway/core.ts applies in production,
      // matching this ticket's "explicit FAILED/NEEDS_A_HAND, never endless QUEUED" requirement.
      const outcome = await executeJob(data, job.id, router);
      expect(outcome.job.status).toBe("NEEDS_A_HAND");
      expect(outcome.runs.every((r) => r.status === "SKIPPED")).toBe(true);
      expect(outcome.artifactId).toBeNull();
    });
  });

  it("agent identity is independent of provider: same agent, different provider, same job contract", () => {
    const d = base();
    const a = d.agents.find((x) => x.id === "agent_02")!;
    const flipped = { ...d, agents: d.agents.map((x) => (x.id === a.id ? { ...x, providerPolicy: { preferred: "gemini" as const, fallbacks: ["claude" as const] } } : x)) };
    const j1 = createJob(d, { projectId: "proj_uproof", agentId: a.id, instructions: "x" }).job;
    const j2 = createJob(flipped, { projectId: "proj_uproof", agentId: a.id, instructions: "x" }).job;
    expect(j1.agentId).toBe(j2.agentId);
    expect(j1.requiredOutputSchema).toBe(j2.requiredOutputSchema);
    expect(j1.preferredProvider).toBe("claude");
    expect(j2.preferredProvider).toBe("gemini");
  });
});

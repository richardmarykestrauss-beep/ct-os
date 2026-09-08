import { describe, expect, it } from "vitest";
import { seedData } from "@/data/seed";
import { ModelRouter } from "@/ai/router";
import { ProviderRegistry } from "@/ai/registry";
import { ClaudeProvider } from "@/ai/providers/claude";
import { OpenAIProvider } from "@/ai/providers/openai";
import { GeminiProvider } from "@/ai/providers/gemini";
import { NoProviderAvailableError } from "@/ai/types";
import { buildProviderRequest, createJob, executeJob } from "@/services/agent-jobs";

const base = () => structuredClone(seedData);

function jobFor(agentId: string) {
  const { data, job } = createJob(base(), { projectId: "proj_uproof", agentId, instructions: "test" });
  return { data, job, request: buildProviderRequest(data, job) };
}

describe("model router", () => {
  it("uses the preferred provider when it is available", async () => {
    const claude = new ClaudeProvider();
    const router = new ModelRouter({ registry: new ProviderRegistry([claude, new OpenAIProvider(), new GeminiProvider()]) });
    const { job, request } = jobFor("agent_02"); // prefers claude
    const result = await router.execute(job, request);
    expect(result.providerId).toBe("claude");
    expect(claude.calls.length).toBe(1);
    expect(result.attempts).toEqual([expect.objectContaining({ providerId: "claude", outcome: "succeeded" })]);
  });

  it("falls back in sequence when the preferred provider fails", async () => {
    const claude = new ClaudeProvider({ failWith: "rate limited" });
    const openai = new OpenAIProvider();
    const router = new ModelRouter({ registry: new ProviderRegistry([claude, openai, new GeminiProvider()]) });
    const { job, request } = jobFor("agent_02"); // claude → openai
    const result = await router.execute(job, request);
    expect(result.providerId).toBe("openai");
    expect(result.attempts.map((a) => [a.providerId, a.outcome])).toEqual([
      ["claude", "failed"],
      ["openai", "succeeded"],
    ]);
    expect(result.attempts[0].error).toBe("rate limited");
  });

  it("skips unavailable providers before trying them", async () => {
    const router = new ModelRouter({ registry: new ProviderRegistry([new ClaudeProvider({ available: false, unavailableReason: "no key" }), new OpenAIProvider(), new GeminiProvider()]) });
    const { job } = jobFor("agent_02");
    const plan = await router.plan(job);
    expect(plan.order).toEqual(["openai"]);
    expect(plan.excluded).toEqual([{ providerId: "claude", reason: "no key" }]);
  });

  it("filters providers that lack a required capability", async () => {
    // Agent 03 needs vision; give OpenAI no vision capability.
    const openai = new OpenAIProvider({ capabilities: ["text", "structured_output"] });
    const router = new ModelRouter({ registry: new ProviderRegistry([new ClaudeProvider({ failWith: "down" }), openai, new GeminiProvider()]) });
    const { job, request } = jobFor("agent_03"); // claude → openai → gemini
    const result = await router.execute(job, request);
    expect(result.providerId).toBe("gemini");
    expect(result.attempts.map((a) => a.providerId + ":" + a.outcome)).toEqual(["claude:failed", "openai:skipped", "gemini:succeeded"]);
  });

  it("throws NoProviderAvailableError with every attempt when all fail, and executeJob records a FAILED job", async () => {
    const router = new ModelRouter({ registry: new ProviderRegistry([new ClaudeProvider({ failWith: "a" }), new OpenAIProvider({ failWith: "b" })]) });
    const { data, job, request } = jobFor("agent_02");
    await expect(router.execute(job, request)).rejects.toBeInstanceOf(NoProviderAvailableError);
    const outcome = await executeJob(data, job.id, router);
    expect(outcome.job.status).toBe("FAILED");
    expect(outcome.job.error).toMatch(/claude \(failed: a\); openai \(failed: b\)/);
    expect(outcome.runs.map((r) => r.status)).toEqual(["FAILED", "FAILED"]);
    expect(outcome.artifactId).toBeNull();
  });

  it("respects a settings-level provider allow-list", async () => {
    const router = new ModelRouter({ registry: new ProviderRegistry([new ClaudeProvider(), new OpenAIProvider(), new GeminiProvider()]), enabledProviders: ["openai"] });
    const { job } = jobFor("agent_02");
    const plan = await router.plan(job);
    expect(plan.order).toEqual(["openai"]);
    expect(plan.excluded[0]).toEqual({ providerId: "claude", reason: "disabled in settings" });
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

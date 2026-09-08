import { describe, expect, it } from "vitest";
import { seedData } from "@/data/seed";
import { ModelRouter } from "@/ai/router";
import { ProviderRegistry } from "@/ai/registry";
import { ClaudeProvider } from "@/ai/providers/claude";
import { OpenAIProvider } from "@/ai/providers/openai";
import { GeminiProvider } from "@/ai/providers/gemini";
import { approveJobOutput, buildProviderRequest, cancelJob, canTransitionJob, createJob, createJobForTicket, executeJob, requestJobRevision, startJob, transitionJob } from "@/services/agent-jobs";

const base = () => structuredClone(seedData);
const router = () => new ModelRouter({ registry: new ProviderRegistry([new ClaudeProvider(), new OpenAIProvider(), new GeminiProvider()]) });

describe("agent job lifecycle", () => {
  it("creates a QUEUED job that inherits the agent's provider policy and permission level", () => {
    const { job } = createJob(base(), { projectId: "proj_uproof", agentId: "agent_02", instructions: "Plan the sitemap" });
    expect(job.status).toBe("QUEUED");
    expect(job.preferredProvider).toBe("claude");
    expect(job.fallbackProviders).toEqual(["openai"]);
    expect(job.permissionLevel).toBe("GREEN");
    expect(job.requiredOutputSchema).toBe("site_blueprint@1");
    expect(job.taskType).toBe("ux_architecture");
    expect(job.outputArtifactId).toBeNull();
  });

  it("enforces legal transitions", () => {
    expect(canTransitionJob("QUEUED", "RUNNING")).toBe(true);
    expect(canTransitionJob("QUEUED", "COMPLETED")).toBe(false);
    expect(canTransitionJob("COMPLETED", "RUNNING")).toBe(false);
    expect(canTransitionJob("WAITING_APPROVAL", "COMPLETED")).toBe(true);
    const { data, job } = createJob(base(), { projectId: "proj_uproof", agentId: "agent_05", instructions: "x" });
    expect(() => transitionJob(data, job.id, "COMPLETED")).toThrow(/not allowed/);
  });

  it("runs QUEUED → RUNNING → WAITING_APPROVAL → COMPLETED with runs, artifact and handoff", async () => {
    const d0 = base();
    const ticket = d0.tickets.find((t) => t.code === "CT-UP-019")!; // QA agent consumes build_report etc.
    const { data: d1, job } = createJobForTicket(d0, ticket);
    expect(job.inputArtifactIds.length).toBeGreaterThan(0);
    expect(job.handoffId).not.toBeNull();
    const handoff = d1.handoffs.find((h) => h.id === job.handoffId)!;
    expect(handoff.sourceAgentId).not.toBe(job.agentId);
    expect(handoff.destinationAgentId).toBe("agent_06");
    expect(handoff.status).toBe("ACCEPTED");

    const outcome = await executeJob(d1, job.id, router());
    expect(outcome.error).toBeNull();
    expect(outcome.job.status).toBe("WAITING_APPROVAL");
    expect(outcome.job.startedAt).not.toBeNull();
    expect(outcome.runs.length).toBe(1);
    expect(outcome.runs[0].providerId).toBe("openai"); // A06 prefers OpenAI
    expect(outcome.runs[0].status).toBe("SUCCEEDED");
    const artifact = outcome.data.artifacts.find((a) => a.id === outcome.artifactId)!;
    expect(artifact.type).toBe("qa_report");
    expect(artifact.status).toBe("DRAFT");
    expect(artifact.createdByProvider).toBe("openai");
    expect(artifact.jobId).toBe(job.id);
    expect(outcome.data.handoffs.find((h) => h.id === job.handoffId)?.status).toBe("IN_PROGRESS");

    const approved = approveJobOutput(outcome.data, job.id);
    expect(approved.job.status).toBe("COMPLETED");
    expect(approved.job.completedAt).not.toBeNull();
    expect(approved.data.artifacts.find((a) => a.id === outcome.artifactId)?.status).toBe("FINAL");
    const done = approved.data.handoffs.find((h) => h.id === job.handoffId)!;
    expect(done.status).toBe("COMPLETED");
    expect(done.outputArtifactId).toBe(outcome.artifactId);
  });

  it("revision re-queues the job and a re-run produces the next artifact version", async () => {
    const d0 = base();
    const ticket = d0.tickets.find((t) => t.code === "CT-UP-019")!;
    const { data: d1, job } = createJobForTicket(d0, ticket);
    const first = await executeJob(d1, job.id, router());
    const requeued = requestJobRevision(first.data, job.id, "tighten evidence");
    expect(requeued.job.status).toBe("QUEUED");
    const second = await executeJob(requeued.data, job.id, router());
    const v2 = second.data.artifacts.find((a) => a.id === second.artifactId)!;
    expect(v2.version).toBe(2);
    expect(v2.supersedesArtifactId).toBe(first.artifactId);
    expect(second.data.artifacts.find((a) => a.id === first.artifactId)?.status).toBe("SUPERSEDED");
    expect(second.data.agentRuns.filter((r) => r.jobId === job.id).map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("cancels a running job and cancels its handoff", () => {
    const d0 = base();
    const ticket = d0.tickets.find((t) => t.code === "CT-UP-019")!;
    const { data: d1, job } = createJobForTicket(d0, ticket);
    const started = startJob(d1, job.id);
    const cancelled = cancelJob(started.data, job.id, "operator");
    expect(cancelled.job.status).toBe("CANCELLED");
    expect(cancelled.data.handoffs.find((h) => h.id === job.handoffId)?.status).toBe("CANCELLED");
  });

  it("builds a provider request with approved knowledge only", () => {
    const d0 = base();
    const { data, job } = createJob(d0, { projectId: "proj_uproof", agentId: "agent_05", instructions: "Build header" });
    const req = buildProviderRequest(data, job);
    expect(req.knowledge.every((k) => k.status === "APPROVED")).toBe(true);
    expect(req.knowledge.some((k) => k.scope === "DOCTRINE")).toBe(true);
    // U-Proof lesson candidates are NOT in force
    expect(req.knowledge.some((k) => k.id.startsWith("kn_up_"))).toBe(false);
    expect(req.systemContext).toContain("WordPress / Elementor Builder");
    expect(req.permissionLevel).toBe("AMBER");
  });
});

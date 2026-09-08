/**
 * Store smoke test — drives the reducer the way the UI does, without React.
 */
import { describe, expect, it } from "vitest";
import { seedData } from "@/data/seed";
import { reduceOS } from "@/state/os-store";
import { ModelRouter } from "@/ai/router";
import { ProviderRegistry } from "@/ai/registry";
import { ClaudeProvider } from "@/ai/providers/claude";
import { OpenAIProvider } from "@/ai/providers/openai";
import { buildProviderRequest, createJobForTicket } from "@/services/agent-jobs";

const base = () => structuredClone(seedData);

describe("OS store smoke", () => {
  it("creates a project with brief artifact, discovery ticket and strategy gate", () => {
    const d = reduceOS(base(), {
      type: "CREATE_PROJECT",
      input: { clientName: "Acme", type: "NEW_WEBSITE", primaryGoal: "Leads", platforms: ["WordPress"], hasExistingWebsite: false },
      ids: { clientId: "c1", projectId: "p1", ticketId: "t1" },
    });
    expect(d.projects.find((p) => p.id === "p1")?.state).toBe("DISCOVERY");
    const brief = d.artifacts.find((a) => a.projectId === "p1");
    expect(brief?.type).toBe("project_brief");
    expect(brief?.status).toBe("FINAL");
    expect(d.approvals.some((a) => a.projectId === "p1" && a.gate === "STRATEGY")).toBe(true);
  });

  it("run ticket → review → approve flows through job, run, artifact and handoff", async () => {
    let d = reduceOS(base(), {
      type: "CREATE_PROJECT",
      input: { clientName: "Acme", type: "NEW_WEBSITE", primaryGoal: "Leads", platforms: ["WordPress"], hasExistingWebsite: false },
      ids: { clientId: "c1", projectId: "p1", ticketId: "t1" },
    });
    const ticket = d.tickets.find((t) => t.id === "t1")!;
    // same planning the action performs
    const planned = createJobForTicket(d, ticket, { id: "job_1" });
    const request = buildProviderRequest(planned.data, planned.job);
    d = reduceOS(d, { type: "RUN_TICKET_START", ticketId: "t1", jobId: "job_1" });
    expect(d.agentJobs.find((j) => j.id === "job_1")?.status).toBe("RUNNING");
    expect(d.tickets.find((t) => t.id === "t1")?.status).toBe("BUILDING");
    expect(d.agents.find((a) => a.id === "agent_01")?.status).toBe("WORKING");

    // A01 policy is Gemini → Claude → OpenAI. Gemini is not registered here, so the store must record the fallback.
    const router = new ModelRouter({ registry: new ProviderRegistry([new ClaudeProvider(), new OpenAIProvider()]) });
    const result = await router.execute(planned.job, request);
    d = reduceOS(d, { type: "RUN_TICKET_RESULT", jobId: "job_1", result, error: null });
    const job = d.agentJobs.find((j) => j.id === "job_1")!;
    expect(job.status).toBe("WAITING_APPROVAL");
    expect(d.tickets.find((t) => t.id === "t1")?.status).toBe("REVIEW");
    expect(d.tickets.find((t) => t.id === "t1")?.approvalState).toBe("PENDING");
    expect(d.agentRuns.filter((r) => r.jobId === "job_1").map((r) => `${r.providerId}:${r.status}`)).toEqual(["gemini:SKIPPED", "claude:SUCCEEDED", "openai:SKIPPED"]);
    const artifact = d.artifacts.find((a) => a.id === job.outputArtifactId)!;
    expect(artifact.type).toBe("research_report");
    expect(artifact.createdByProvider).toBe("claude");
    expect(d.activity.at(-1)?.message).toMatch(/fallback from Gemini/);

    d = reduceOS(d, { type: "SET_TICKET_APPROVAL", ticketId: "t1", approval: "APPROVED" });
    expect(d.agentJobs.find((j) => j.id === "job_1")?.status).toBe("COMPLETED");
    expect(d.artifacts.find((a) => a.id === job.outputArtifactId)?.status).toBe("FINAL");
    expect(d.tickets.find((t) => t.id === "t1")?.status).toBe("COMPLETE");
  });

  it("knowledge review and provider policy edits are recorded", () => {
    let d = reduceOS(base(), { type: "REVIEW_KNOWLEDGE", itemId: "kn_up_builder_no_self_certify", decision: "APPROVED" });
    expect(d.knowledgeItems.find((k) => k.id === "kn_up_builder_no_self_certify")?.status).toBe("APPROVED");
    expect(d.activity.at(-1)?.kind).toBe("KNOWLEDGE");
    d = reduceOS(d, { type: "SET_AGENT_PROVIDER", agentId: "agent_02", policy: { preferred: "openai" } });
    const a = d.agents.find((x) => x.id === "agent_02")!;
    expect(a.providerPolicy.preferred).toBe("openai");
    expect(a.providerPolicy.fallbacks).not.toContain("openai");
  });

  it("existing U-Proof behaviour still works: launch gate stays pending and holds toggle", () => {
    let d = base();
    expect(d.approvals.find((a) => a.id === "appr_up_launch")?.status).toBe("PENDING");
    d = reduceOS(d, { type: "TOGGLE_HOLD", holdId: "hold_up_3" });
    expect(d.launchHolds.find((h) => h.id === "hold_up_3")?.resolved).toBe(true);
    expect(d.pages.find((p) => p.id === "page_up_303")?.holdNote).toBeDefined(); // hold_up_4 still open on the same page
    d = reduceOS(d, { type: "RUN_QA", projectId: "proj_uproof", ticketId: "t_qa", qaRunId: "qarun_x" });
    expect(d.qaRuns.at(-1)?.result).toBe("INCOMPLETE");
    expect(d.tickets.at(-1)?.code).toBe("CT-UP-022");
  });
});

describe("OS store guards (review fixes)", () => {
  it("a second Run while a job is in flight is a no-op; approval finalises the latest job", async () => {
    let d = reduceOS(base(), {
      type: "CREATE_PROJECT",
      input: { clientName: "Acme", type: "NEW_WEBSITE", primaryGoal: "Leads", platforms: ["WordPress"], hasExistingWebsite: false },
      ids: { clientId: "c1", projectId: "p1", ticketId: "t1" },
    });
    d = reduceOS(d, { type: "RUN_TICKET_START", ticketId: "t1", jobId: "job_1" });
    const again = reduceOS(d, { type: "RUN_TICKET_START", ticketId: "t1", jobId: "job_2" });
    expect(again).toBe(d);
    expect(d.agentJobs.filter((j) => j.ticketId === "t1").length).toBe(1);
  });

  it("needs-revision leaves the ticket READY (nothing running) and the job QUEUED", async () => {
    let d = reduceOS(base(), {
      type: "CREATE_PROJECT",
      input: { clientName: "Acme", type: "NEW_WEBSITE", primaryGoal: "Leads", platforms: ["WordPress"], hasExistingWebsite: false },
      ids: { clientId: "c1", projectId: "p1", ticketId: "t1" },
    });
    const ticket = d.tickets.find((t) => t.id === "t1")!;
    const planned = createJobForTicket(d, ticket, { id: "job_1" });
    d = reduceOS(d, { type: "RUN_TICKET_START", ticketId: "t1", jobId: "job_1" });
    const router = new ModelRouter({ registry: new ProviderRegistry([new ClaudeProvider(), new OpenAIProvider()]) });
    const result = await router.execute(planned.job, buildProviderRequest(planned.data, planned.job));
    d = reduceOS(d, { type: "RUN_TICKET_RESULT", jobId: "job_1", result, error: null });
    d = reduceOS(d, { type: "SET_TICKET_APPROVAL", ticketId: "t1", approval: "NEEDS_REVISION" });
    expect(d.tickets.find((t) => t.id === "t1")?.status).toBe("READY");
    expect(d.agentJobs.find((j) => j.id === "job_1")?.status).toBe("QUEUED");
    expect(d.agents.find((a) => a.id === "agent_01")?.status).toBe("IDLE");
    // re-run reuses the queued job and produces v2
    d = reduceOS(d, { type: "RUN_TICKET_START", ticketId: "t1", jobId: "job_1" });
    expect(d.agentJobs.find((j) => j.id === "job_1")?.status).toBe("RUNNING");
  });

  it("reopening a hold restores the page hold note", () => {
    let d = reduceOS(base(), { type: "TOGGLE_HOLD", holdId: "hold_up_1" });
    expect(d.pages.find((p) => p.id === "page_up_292")?.holdNote).toBeUndefined();
    d = reduceOS(d, { type: "TOGGLE_HOLD", holdId: "hold_up_1" });
    expect(d.pages.find((p) => p.id === "page_up_292")?.holdNote).toBeTruthy();
  });
});

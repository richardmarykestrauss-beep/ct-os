/**
 * Store smoke test — drives the reducer the way the UI does, without React. Executions go through
 * the embedded gateway core over the same snapshot, exactly as the local-mode client does.
 */
import { describe, expect, it } from "vitest";
import { reduceOS } from "@/state/os-store";
import { ModelRouter } from "@/ai/router";
import { ProviderRegistry } from "@/ai/registry";
import { StubProvider } from "@/ai/providers/stub";
import { handleExecute } from "@/gateway/core";
import { OSDataGatewayStore } from "@/gateway/store";
import type { OSData } from "@/data/types";
import { base, lead, ROLES_BY_ID } from "./fixtures";

const registry = () => new ProviderRegistry([new StubProvider({ id: "claude" }), new StubProvider({ id: "openai" })]); // gemini not registered
async function runThroughGateway(d: OSData, jobId: string) {
  const store = new OSDataGatewayStore(d, ROLES_BY_ID);
  const response = await handleExecute({ token: "t", jobId }, { auth: { verify: async (t) => (t === "t" ? lead : null) }, store, router: new ModelRouter({ registry: registry() }), mode: "local" });
  return response;
}

const newProject = (d: OSData) =>
  reduceOS(d, {
    type: "CREATE_PROJECT",
    input: { clientName: "Acme", type: "NEW_WEBSITE", primaryGoal: "Leads", platforms: ["WordPress"], hasExistingWebsite: false },
    ids: { clientId: "c1", projectId: "p1", ticketId: "t1" },
    actor: lead,
  });

describe("OS store smoke", () => {
  it("creates a project with brief artifact, discovery ticket and strategy gate, recording the actor", () => {
    const d = newProject(base());
    expect(d.projects.find((p) => p.id === "p1")?.state).toBe("DISCOVERY");
    const brief = d.artifacts.find((a) => a.projectId === "p1");
    expect(brief?.type).toBe("project_brief");
    expect(brief?.status).toBe("FINAL");
    expect(d.approvals.some((a) => a.projectId === "p1" && a.gate === "STRATEGY")).toBe(true);
    const created = d.activity.find((a) => a.kind === "PROJECT_CREATED" && a.projectId === "p1");
    expect(created?.actor).toBe("Production Lead");
    expect(created?.actorId).toBe("u_lead");
  });

  it("run ticket → gateway → review → approve flows through job, runs, validated artifact and handoff", async () => {
    let d = newProject(base());
    d = reduceOS(d, { type: "RUN_TICKET_START", ticketId: "t1", jobId: "job_1", handoffId: "h_job_1", actor: lead });
    expect(d.agentJobs.find((j) => j.id === "job_1")?.status).toBe("RUNNING");
    expect(d.agentJobs.find((j) => j.id === "job_1")?.requestedById).toBe("u_lead");
    expect(d.tickets.find((t) => t.id === "t1")?.status).toBe("BUILDING");
    expect(d.agents.find((a) => a.id === "agent_01")?.status).toBe("WORKING");

    // A01 policy is Gemini → Claude → OpenAI. Gemini is not registered, so the fallback must be recorded.
    const response = await runThroughGateway(d, "job_1");
    expect(response.ok).toBe(true);
    d = reduceOS(d, { type: "APPLY_EXECUTION", jobId: "job_1", response, actor: lead });
    const job = d.agentJobs.find((j) => j.id === "job_1")!;
    expect(job.status).toBe("WAITING_APPROVAL");
    expect(d.tickets.find((t) => t.id === "t1")?.status).toBe("REVIEW");
    expect(d.tickets.find((t) => t.id === "t1")?.approvalState).toBe("PENDING");
    expect(d.agentRuns.filter((r) => r.jobId === "job_1").map((r) => `${r.providerId}:${r.status}`)).toEqual(["gemini:SKIPPED", "claude:SUCCEEDED", "openai:SKIPPED"]);
    const artifact = d.artifacts.find((a) => a.id === job.outputArtifactId)!;
    expect(artifact.type).toBe("research_report");
    expect(artifact.createdByProvider).toBe("claude");
    expect(d.executionLogs.filter((l) => l.jobId === "job_1").length).toBe(3);
    expect(d.activity.at(-1)?.message).toMatch(/after fallback: Gemini — skipped/);

    d = reduceOS(d, { type: "SET_TICKET_APPROVAL", ticketId: "t1", approval: "APPROVED", actor: lead });
    expect(d.agentJobs.find((j) => j.id === "job_1")?.status).toBe("COMPLETED");
    expect(d.artifacts.find((a) => a.id === job.outputArtifactId)?.status).toBe("FINAL");
    expect(d.tickets.find((t) => t.id === "t1")?.status).toBe("COMPLETE");
  });

  it("knowledge review and provider policy edits are recorded with identity", () => {
    let d = reduceOS(base(), { type: "REVIEW_KNOWLEDGE", itemId: "kn_up_builder_no_self_certify", decision: "APPROVED", actor: lead });
    const item = d.knowledgeItems.find((k) => k.id === "kn_up_builder_no_self_certify")!;
    expect(item.status).toBe("APPROVED");
    expect(item.reviewedBy).toBe("Production Lead");
    expect(item.reviewedById).toBe("u_lead");
    expect(d.activity.at(-1)?.kind).toBe("KNOWLEDGE");
    d = reduceOS(d, { type: "SET_AGENT_PROVIDER", agentId: "agent_02", policy: { preferred: "openai" }, actor: lead });
    const a = d.agents.find((x) => x.id === "agent_02")!;
    expect(a.providerPolicy.preferred).toBe("openai");
    expect(a.providerPolicy.fallbacks).not.toContain("openai");
  });

  it("existing U-Proof behaviour still works: launch gate stays pending, holds toggle, QA run mints the next code", () => {
    let d = base();
    expect(d.approvals.find((a) => a.id === "appr_up_launch")?.status).toBe("PENDING");
    d = reduceOS(d, { type: "TOGGLE_HOLD", holdId: "hold_up_3", actor: lead });
    expect(d.launchHolds.find((h) => h.id === "hold_up_3")?.resolved).toBe(true);
    expect(d.pages.find((p) => p.id === "page_up_303")?.holdNote).toBeDefined();
    d = reduceOS(d, { type: "RUN_QA", projectId: "proj_uproof", ticketId: "t_qa", qaRunId: "qarun_x", actor: lead });
    expect(d.qaRuns.at(-1)?.result).toBe("INCOMPLETE");
    expect(d.tickets.at(-1)?.code).toBe("CT-UP-022");
    d = reduceOS(d, { type: "DECIDE_APPROVAL", approvalId: "appr_up_launch", status: "CHANGES_REQUESTED", actor: lead });
    const launch = d.approvals.find((a) => a.id === "appr_up_launch")!;
    expect(launch.decidedBy).toBe("Production Lead");
    expect(launch.decidedById).toBe("u_lead");
  });
});

describe("OS store guards (CTOS-001 review fixes, still enforced)", () => {
  it("a second Run while a job is in flight is a no-op", () => {
    let d = newProject(base());
    d = reduceOS(d, { type: "RUN_TICKET_START", ticketId: "t1", jobId: "job_1", handoffId: "h_job_1", actor: lead });
    const again = reduceOS(d, { type: "RUN_TICKET_START", ticketId: "t1", jobId: "job_2", handoffId: "h_job_2", actor: lead });
    expect(again).toBe(d);
    expect(d.agentJobs.filter((j) => j.ticketId === "t1").length).toBe(1);
  });

  it("needs-revision leaves the ticket READY and the job QUEUED; a re-run produces v2", async () => {
    let d = newProject(base());
    d = reduceOS(d, { type: "RUN_TICKET_START", ticketId: "t1", jobId: "job_1", handoffId: "h_job_1", actor: lead });
    d = reduceOS(d, { type: "APPLY_EXECUTION", jobId: "job_1", response: await runThroughGateway(d, "job_1"), actor: lead });
    d = reduceOS(d, { type: "SET_TICKET_APPROVAL", ticketId: "t1", approval: "NEEDS_REVISION", actor: lead });
    expect(d.tickets.find((t) => t.id === "t1")?.status).toBe("READY");
    expect(d.agentJobs.find((j) => j.id === "job_1")?.status).toBe("QUEUED");
    expect(d.agents.find((a) => a.id === "agent_01")?.status).toBe("IDLE");
    d = reduceOS(d, { type: "RUN_TICKET_START", ticketId: "t1", jobId: "job_1", handoffId: "h_job_1", actor: lead });
    expect(d.agentJobs.find((j) => j.id === "job_1")?.status).toBe("RUNNING");
    d = reduceOS(d, { type: "APPLY_EXECUTION", jobId: "job_1", response: await runThroughGateway(d, "job_1"), actor: lead });
    const v2 = d.artifacts.find((a) => a.id === d.agentJobs.find((j) => j.id === "job_1")!.outputArtifactId)!;
    expect(v2.version).toBe(2);
    expect(d.artifacts.filter((a) => a.ticketId === "t1" && a.status === "SUPERSEDED").length).toBe(1);
  });

  it("reopening a hold restores the page hold note", () => {
    let d = reduceOS(base(), { type: "TOGGLE_HOLD", holdId: "hold_up_1", actor: lead });
    expect(d.pages.find((p) => p.id === "page_up_292")?.holdNote).toBeUndefined();
    d = reduceOS(d, { type: "TOGGLE_HOLD", holdId: "hold_up_1", actor: lead });
    expect(d.pages.find((p) => p.id === "page_up_292")?.holdNote).toBeTruthy();
  });
});

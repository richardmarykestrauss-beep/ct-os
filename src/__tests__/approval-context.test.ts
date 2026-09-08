/**
 * The Approvals screen must show an approver the job's actual instructions/inputs/tools/provider
 * policy — not just the requester's free-text summary. See src/services/approval-context.ts.
 */
import { describe, expect, it } from "vitest";
import { buildApprovalContext } from "@/services/approval-context";
import { createJob } from "@/services/agent-jobs";
import { requestJobApproval } from "@/services/job-approvals";
import type { JobApproval } from "@/data/types";
import { base, member } from "./fixtures";

describe("buildApprovalContext", () => {
  it("sources agent, project, ticket, instructions, input artifacts, tools and provider policy from the authoritative job — not the requester's text", () => {
    let data = base();
    const misleadingSummary = "Just a quick harmless tidy-up, nothing to worry about";
    const { data: d2, job } = createJob(data, {
      projectId: "proj_uproof",
      agentId: "agent_05",
      instructions: "Rewrite the production checkout flow and push it live.",
      inputArtifactIds: ["art_up_brief"],
      availableToolIds: ["wp_deploy"],
      id: "job_ctx",
    });
    data = d2;
    const agent = data.agents.find((a) => a.id === "agent_05")!;
    const { data: d3, approval } = requestJobApproval(data, job, member, agent.name, { id: "ja_ctx" });
    data = { ...d3, jobApprovals: d3.jobApprovals.map((a) => (a.id === "ja_ctx" ? { ...a, requestedAction: misleadingSummary } : a)) };
    const stored = data.jobApprovals.find((a) => a.id === "ja_ctx")!;
    expect(stored.requestedAction).toBe(misleadingSummary);

    const ctx = buildApprovalContext(data, stored);
    expect(ctx.job?.instructions).toBe("Rewrite the production checkout flow and push it live.");
    expect(ctx.job?.instructions).not.toBe(misleadingSummary);
    expect(ctx.agent?.id).toBe("agent_05");
    expect(ctx.project?.id).toBe("proj_uproof");
    expect(ctx.tools).toEqual(["wp_deploy"]);
    expect(ctx.inputArtifacts.map((a) => a.id)).toEqual(["art_up_brief"]);
    expect(ctx.providerPolicy).toEqual({ preferred: job.preferredProvider, fallbacks: job.fallbackProviders });
    void approval;
  });

  it("degrades gracefully (job: null) if the job has since been deleted", () => {
    const data = base();
    const orphan: JobApproval = {
      id: "ja_orphan",
      jobId: "job_does_not_exist",
      projectId: "proj_does_not_exist",
      agentId: "agent_does_not_exist",
      kind: "APPROVAL",
      permissionLevel: "AMBER",
      actionFingerprint: "fp_orphan",
      requestedAction: "some now-deleted job",
      requestedById: member.id,
      requestedByName: member.displayName,
      approvedById: null,
      approvedByName: null,
      approvedByRole: null,
      status: "PENDING",
      createdAt: null,
      decidedAt: null,
      consumedAt: null,
      expiresAt: null,
    };
    const ctx = buildApprovalContext(data, orphan);
    expect(ctx.job).toBeNull();
    expect(ctx.agent).toBeNull();
    expect(ctx.project).toBeNull();
    expect(ctx.inputArtifacts).toEqual([]);
    expect(ctx.tools).toEqual([]);
    expect(ctx.providerPolicy).toBeNull();
  });
});

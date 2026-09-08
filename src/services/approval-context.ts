/**
 * Authoritative approval context (CTOS-002A).
 *
 * `job_approvals.requested_action` is free text written by the requester at request time — useful as
 * a human summary, but never the thing an approver should rely on to decide. This assembles what an
 * approver should actually see, sourced entirely from the authoritative job record (and the records
 * it references), not from anything the requester typed. The action fingerprint still binds the
 * approval to the exact job/instructions/schema/tools/provider-policy combination server-side
 * (see services/job-approvals.ts actionFingerprint) — this is what makes that binding legible to a
 * human before they approve it.
 */
import type { Agent, AgentJob, Artifact, JobApproval, OSData, Project, Ticket } from "@/data/types";

export interface ApprovalContext {
  approval: JobApproval;
  /** null only if the job has since been deleted (ADMIN-only, and cascades the approval too — so this is defensive, not expected in practice). */
  job: AgentJob | null;
  agent: Agent | null;
  project: Project | null;
  ticket: Ticket | null;
  inputArtifacts: Artifact[];
  tools: string[];
  providerPolicy: { preferred: string; fallbacks: string[] } | null;
}

export function buildApprovalContext(data: OSData, approval: JobApproval): ApprovalContext {
  const job = data.agentJobs.find((j) => j.id === approval.jobId) ?? null;
  const agent = data.agents.find((a) => a.id === approval.agentId) ?? null;
  const project = data.projects.find((p) => p.id === approval.projectId) ?? null;
  const ticket = job?.ticketId ? (data.tickets.find((t) => t.id === job.ticketId) ?? null) : null;
  const inputArtifacts = job ? data.artifacts.filter((a) => job.inputArtifactIds.includes(a.id)) : [];
  const tools = job?.availableToolIds ?? [];
  const providerPolicy = job ? { preferred: job.preferredProvider, fallbacks: job.fallbackProviders } : null;
  return { approval, job, agent, project, ticket, inputArtifacts, tools, providerPolicy };
}

/**
 * GatewayStore — the server-side truth the execution gateway reads and writes.
 *
 * Two implementations:
 *  - OSDataGatewayStore: over an OSData snapshot (embedded/local mode and tests)
 *  - SupabaseGatewayStore: over Supabase with the service role (Edge Function / dev middleware)
 * The gateway core only ever talks to this interface, so enforcement logic is identical everywhere.
 */
import type { Agent, AgentJob, Artifact, JobApproval, KnowledgeItem, OSData, UserRole } from "@/data/types";
import { knowledgeForJob } from "@/services/knowledge";
import { applyGatewayRecords, type GatewayRecords } from "@/services/agent-jobs";
import { parseSchemaName } from "@/schemas/artifacts";

export interface JobContext {
  job: AgentJob;
  agent: Agent;
  inputArtifacts: Artifact[];
  /** APPROVED knowledge for this project/job only. */
  knowledge: KnowledgeItem[];
  approvals: JobApproval[];
  /** The current non-superseded output for this job's lineage (to version), if any. */
  previousOutput: Artifact | null;
  existingRunCount: number;
  handoff: GatewayRecords["handoff"];
}

export interface GatewayStore {
  loadJobContext(jobId: string): Promise<JobContext | null>;
  /** Role from profiles, when the store has identities (Supabase). null = unknown. */
  getUserRole(userId: string): Promise<UserRole | null>;
  /**
   * Atomically claim the job for one execution. Returns false when another execution holds a live
   * claim (younger than `leaseMs`). Prevents double execution / double versioning / double consumption.
   */
  claimJob(jobId: string, claimId: string, leaseMs: number): Promise<boolean>;
  /** Release a claim without committing (permission denied, provider failure paths still commit). */
  releaseJob(jobId: string, claimId: string): Promise<void>;
  /** Persist what an execution produced. Must be idempotent by id. */
  commit(records: GatewayRecords): Promise<void>;
}

/** Store over an in-memory OSData snapshot. `data` is replaced on commit so callers can read it back. */
export class OSDataGatewayStore implements GatewayStore {
  data: OSData;
  readonly roles: Map<string, UserRole>;
  private readonly claims = new Map<string, { claimId: string; at: number }>();
  constructor(data: OSData, roles: Record<string, UserRole> = {}) {
    this.data = data;
    this.roles = new Map(Object.entries(roles));
  }
  async claimJob(jobId: string, claimId: string, leaseMs: number) {
    const now = Date.now();
    const existing = this.claims.get(jobId);
    if (existing && existing.claimId !== claimId && now - existing.at < leaseMs) return false;
    this.claims.set(jobId, { claimId, at: now });
    return true;
  }
  async releaseJob(jobId: string, claimId: string) {
    if (this.claims.get(jobId)?.claimId === claimId) this.claims.delete(jobId);
  }
  async loadJobContext(jobId: string): Promise<JobContext | null> {
    const d = this.data;
    const job = d.agentJobs.find((j) => j.id === jobId);
    if (!job) return null;
    const agent = d.agents.find((a) => a.id === job.agentId);
    if (!agent) return null;
    const type = parseSchemaName(job.requiredOutputSchema).type;
    return {
      job,
      agent,
      inputArtifacts: job.inputArtifactIds.map((id) => d.artifacts.find((a) => a.id === id)).filter((a): a is Artifact => !!a),
      knowledge: knowledgeForJob(d, job.projectId, job.id),
      approvals: d.jobApprovals.filter((a) => a.jobId === jobId),
      previousOutput: job.ticketId ? (d.artifacts.find((a) => a.jobId && a.type === type && a.projectId === job.projectId && a.ticketId === job.ticketId && a.status !== "SUPERSEDED") ?? null) : null,
      existingRunCount: d.agentRuns.filter((r) => r.jobId === jobId).length,
      handoff: job.handoffId ? (d.handoffs.find((h) => h.id === job.handoffId) ?? null) : null,
    };
  }
  async getUserRole(userId: string) {
    return this.roles.get(userId) ?? null;
  }
  async commit(records: GatewayRecords) {
    this.data = applyGatewayRecords(this.data, records);
    this.claims.delete(records.job.id);
  }
}

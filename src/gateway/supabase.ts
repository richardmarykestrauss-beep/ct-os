/**
 * Supabase-backed gateway store and auth.
 *
 * Runtime-neutral: it talks to a narrow `GatewayDb` / `AuthApi` pair. `supabaseDb()` and
 * `supabaseAuthApi()` adapt a supabase-js client (service role) to those interfaces; a fake pair
 * drives the tests. The service-role key is held by the client instance the runtime wrapper
 * creates — it is never read here and never leaves the server.
 */
import type { Agent, AgentJob, Artifact, AuthUser, Handoff, JobApproval, KnowledgeItem, UserRole } from "@/data/types";
import type { GatewayRecords } from "@/services/agent-jobs";
import { fromRow, specFor, toRow, type Row } from "@/services/supabase/mapping";
import { parseSchemaName } from "@/schemas/artifacts";
import type { GatewayAuth } from "./core";
import type { GatewayStore, JobContext } from "./store";

export interface DbFilter {
  column: string;
  op: "eq" | "in";
  value: unknown;
}

export interface GatewayDb {
  select(table: string, filters: DbFilter[]): Promise<Row[]>;
  upsert(table: string, rows: Row[]): Promise<void>;
  /** Conditional update; returns the number of rows changed. Used for leases and one-shot consumption. */
  updateWhere(table: string, patch: Row, filters: DbFilter[]): Promise<number>;
}

export interface AuthApi {
  /** Validate a user JWT; null when invalid/expired. */
  getUser(token: string): Promise<{ id: string; email: string | null } | null>;
}

const ROLES: UserRole[] = ["ADMIN", "PRODUCTION_LEAD", "TEAM_MEMBER", "VIEWER"];

export class SupabaseGatewayAuth implements GatewayAuth {
  constructor(
    private readonly api: AuthApi,
    private readonly db: GatewayDb,
  ) {}
  async verify(token: string | null): Promise<AuthUser | null> {
    if (!token) return null;
    let user: { id: string; email: string | null } | null;
    try {
      user = await this.api.getUser(token);
    } catch {
      return null;
    }
    if (!user) return null;
    const rows = await this.db.select("profiles", [{ column: "id", op: "eq", value: user.id }]);
    const profile = rows[0];
    // Independent of the UI: an inactive account (unapproved sign-up, or an ADMIN-deactivated one)
    // is rejected here even if it somehow presents a valid session token.
    if (profile?.active === false) return null;
    const role = profile && ROLES.includes(profile.role as UserRole) ? (profile.role as UserRole) : "VIEWER";
    return { id: user.id, email: user.email, displayName: (profile?.display_name as string | undefined) || user.email || user.id, role, active: profile?.active !== false };
  }
}

export class SupabaseGatewayStore implements GatewayStore {
  constructor(private readonly db: GatewayDb) {}

  async loadJobContext(jobId: string): Promise<JobContext | null> {
    const jobRow = (await this.db.select("agent_jobs", [{ column: "id", op: "eq", value: jobId }]))[0];
    if (!jobRow) return null;
    const job = fromRow<AgentJob>(specFor("agent_jobs"), jobRow);
    const agentRow = (await this.db.select("agents", [{ column: "id", op: "eq", value: job.agentId }]))[0];
    if (!agentRow) return null;
    const agent = fromRow<Agent>(specFor("agents"), agentRow);
    const inputArtifacts = job.inputArtifactIds.length ? (await this.db.select("artifacts", [{ column: "id", op: "in", value: job.inputArtifactIds }])).map((r) => fromRow<Artifact>(specFor("artifacts"), r)) : [];
    const global = (await this.db.select("knowledge_items", [{ column: "scope", op: "in", value: ["DOCTRINE", "AGENCY"] }, { column: "status", op: "eq", value: "APPROVED" }])).map((r) => fromRow<KnowledgeItem>(specFor("knowledge_items"), r));
    const scoped = (await this.db.select("knowledge_items", [{ column: "project_id", op: "eq", value: job.projectId }, { column: "status", op: "eq", value: "APPROVED" }])).map((r) => fromRow<KnowledgeItem>(specFor("knowledge_items"), r));
    const knowledge = [...global, ...scoped.filter((k) => k.scope === "PROJECT" || (k.scope === "TASK" && k.jobId === job.id))];
    const approvals = (await this.db.select("job_approvals", [{ column: "job_id", op: "eq", value: jobId }])).map((r) => fromRow<JobApproval>(specFor("job_approvals"), r));
    const type = parseSchemaName(job.requiredOutputSchema).type;
    let previousOutput: Artifact | null = null;
    if (job.ticketId) {
      const rows = await this.db.select("artifacts", [{ column: "ticket_id", op: "eq", value: job.ticketId }, { column: "type", op: "eq", value: type }]);
      previousOutput = rows.map((r) => fromRow<Artifact>(specFor("artifacts"), r)).find((a) => a.jobId && a.projectId === job.projectId && a.status !== "SUPERSEDED") ?? null;
    }
    const existingRunCount = (await this.db.select("agent_runs", [{ column: "job_id", op: "eq", value: jobId }])).length;
    const handoff = job.handoffId ? ((await this.db.select("handoffs", [{ column: "id", op: "eq", value: job.handoffId }])).map((r) => fromRow<Handoff>(specFor("handoffs"), r))[0] ?? null) : null;
    return { job, agent, inputArtifacts, knowledge, approvals, previousOutput, existingRunCount, handoff };
  }

  async getUserRole(userId: string): Promise<UserRole | null> {
    const row = (await this.db.select("profiles", [{ column: "id", op: "eq", value: userId }]))[0];
    return row && ROLES.includes(row.role as UserRole) ? (row.role as UserRole) : null;
  }

  /** Lease on agent_jobs.execution_claim_id / execution_claimed_at (migration 0002). */
  async claimJob(jobId: string, claimId: string, leaseMs: number): Promise<boolean> {
    const rows = await this.db.select("agent_jobs", [{ column: "id", op: "eq", value: jobId }]);
    const row = rows[0];
    if (!row) return false;
    const claimedAt = typeof row.execution_claimed_at === "string" ? Date.parse(row.execution_claimed_at) : NaN;
    const live = typeof row.execution_claim_id === "string" && row.execution_claim_id !== claimId && Number.isFinite(claimedAt) && Date.now() - claimedAt < leaseMs;
    if (live) return false;
    // Conditional on the claim we just observed, so two racers cannot both win.
    const filters: DbFilter[] = [{ column: "id", op: "eq", value: jobId }, { column: "execution_claim_id", op: "eq", value: row.execution_claim_id ?? null }];
    const n = await this.db.updateWhere("agent_jobs", { execution_claim_id: claimId, execution_claimed_at: new Date().toISOString() }, filters);
    return n === 1;
  }

  async releaseJob(jobId: string, claimId: string): Promise<void> {
    await this.db.updateWhere("agent_jobs", { execution_claim_id: null, execution_claimed_at: null }, [{ column: "id", op: "eq", value: jobId }, { column: "execution_claim_id", op: "eq", value: claimId }]);
  }

  /** Writes in foreign-key order: artifacts → runs → job → handoff → approval → logs. */
  async commit(records: GatewayRecords): Promise<void> {
    if (records.supersededArtifactId) {
      const prev = (await this.db.select("artifacts", [{ column: "id", op: "eq", value: records.supersededArtifactId }]))[0];
      if (prev) await this.db.upsert("artifacts", [{ ...prev, status: "SUPERSEDED", updated_at: records.artifact?.createdAt ?? prev.updated_at }]);
    }
    if (records.artifact) await this.db.upsert("artifacts", [toRow(records.artifact)]);
    if (records.runs.length) await this.db.upsert("agent_runs", records.runs.map(toRow));
    // The job row also clears the execution lease.
    await this.db.upsert("agent_jobs", [{ ...toRow(records.job), execution_claim_id: null, execution_claimed_at: null }]);
    if (records.handoff) await this.db.upsert("handoffs", [toRow(records.handoff)]);
    if (records.approval) {
      // One-shot consumption: only an APPROVED row can become CONSUMED.
      const n = await this.db.updateWhere("job_approvals", { status: records.approval.status, consumed_at: records.approval.consumedAt }, [{ column: "id", op: "eq", value: records.approval.id }, { column: "status", op: "eq", value: "APPROVED" }]);
      if (n !== 1) throw new Error(`Approval ${records.approval.id} was already consumed or revoked`);
    }
    if (records.logs.length) await this.db.upsert("execution_logs", records.logs.map(toRow));
  }
}

// ---------------------------------------------------------------------------
// supabase-js adapters (structural types so this file never imports the SDK)
// ---------------------------------------------------------------------------

interface QueryBuilder extends PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  eq(column: string, value: unknown): QueryBuilder;
  is(column: string, value: null): QueryBuilder;
  in(column: string, values: unknown[]): QueryBuilder;
  select(columns: string): QueryBuilder;
}
export interface SupabaseServiceClientLike {
  from(table: string): {
    select(columns: string): QueryBuilder;
    update(patch: Row): QueryBuilder;
    upsert(rows: Row[], opts?: { onConflict?: string }): PromiseLike<{ error: { message: string } | null }>;
  };
  auth: { getUser(token: string): Promise<{ data: { user: { id: string; email?: string | null } | null }; error: { message: string } | null }> };
}

export function supabaseDb(client: SupabaseServiceClientLike): GatewayDb {
  return {
    async select(table, filters) {
      let q = client.from(table).select("*");
      for (const f of filters) q = f.op === "eq" ? q.eq(f.column, f.value) : q.in(f.column, f.value as unknown[]);
      const res = await q;
      if (res.error) throw new Error(`gateway db select ${table}: ${res.error.message}`);
      return res.data ?? [];
    },
    async upsert(table, rows) {
      const res = await client.from(table).upsert(rows, { onConflict: "id" });
      if (res.error) throw new Error(`gateway db upsert ${table}: ${res.error.message}`);
    },
    async updateWhere(table, patch, filters) {
      let q = client.from(table).update(patch);
      for (const f of filters) q = f.op === "eq" ? (f.value === null ? q.is(f.column, null) : q.eq(f.column, f.value)) : q.in(f.column, f.value as unknown[]);
      const res = await q.select("id");
      if (res.error) throw new Error(`gateway db update ${table}: ${res.error.message}`);
      return res.data?.length ?? 0;
    },
  };
}

export function supabaseAuthApi(client: SupabaseServiceClientLike): AuthApi {
  return {
    async getUser(token) {
      const res = await client.auth.getUser(token);
      if (res.error || !res.data.user) return null;
      return { id: res.data.user.id, email: res.data.user.email ?? null };
    },
  };
}

/** In-memory GatewayDb for tests. */
export class FakeGatewayDb implements GatewayDb {
  readonly tables = new Map<string, Map<string, Row>>();
  seed(table: string, rows: Row[]) {
    const t = this.tables.get(table) ?? new Map<string, Row>();
    for (const r of rows) t.set(String(r.id), structuredClone(r));
    this.tables.set(table, t);
    return this;
  }
  async select(table: string, filters: DbFilter[]) {
    const rows = [...(this.tables.get(table)?.values() ?? [])];
    return rows.filter((r) => filters.every((f) => (f.op === "eq" ? r[f.column] === f.value : (f.value as unknown[]).includes(r[f.column])))).map((r) => structuredClone(r));
  }
  async upsert(table: string, rows: Row[]) {
    this.seed(table, rows);
  }
  async updateWhere(table: string, patch: Row, filters: DbFilter[]) {
    const t = this.tables.get(table) ?? new Map<string, Row>();
    let n = 0;
    for (const [id, row] of t) {
      const match = filters.every((f) => (f.op === "eq" ? (row[f.column] ?? null) === (f.value ?? null) : (f.value as unknown[]).includes(row[f.column])));
      if (match) {
        t.set(id, { ...row, ...patch });
        n++;
      }
    }
    this.tables.set(table, t);
    return n;
  }
}

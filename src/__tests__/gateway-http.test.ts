/**
 * Gateway HTTP surface, the Supabase-backed store/auth (against a fake DB), schema validation,
 * and the auth backends. Still no network.
 */
import { describe, expect, it } from "vitest";
import { seedData } from "@/data/seed";
import { ModelRouter } from "@/ai/router";
import { ProviderRegistry } from "@/ai/registry";
import { StubProvider } from "@/ai/providers/stub";
import { bearerToken, handleGatewayHttp } from "@/gateway/http";
import { FakeGatewayDb, SupabaseGatewayAuth, SupabaseGatewayStore, type AuthApi } from "@/gateway/supabase";
import type { GatewayDeps } from "@/gateway/core";
import { OSDataGatewayStore } from "@/gateway/store";
import { TABLES, toRow } from "@/services/supabase/mapping";
import { createJob } from "@/services/agent-jobs";
import { validateOutput, EXAMPLES, SCHEMAS, jsonSchemaFor } from "@/schemas/artifacts";
import { LocalAuthBackend, SupabaseAuthBackend, type SupabaseAuthClientLike } from "@/auth/backend";
import { base, lead, member, ROLES_BY_ID } from "./fixtures";

const UUID_LEAD = "11111111-1111-4111-8111-111111111111";
const UUID_MEMBER = "22222222-2222-4222-8222-222222222222";

function fakeDbFromSeed(extra: Partial<typeof seedData> = {}) {
  const db = new FakeGatewayDb();
  const data = { ...base(), ...extra };
  for (const spec of TABLES) db.seed(spec.table, (data[spec.key] as object[]).map(toRow));
  db.seed("profiles", [
    { id: UUID_LEAD, email: "lead@ct.test", display_name: "Lead", role: "PRODUCTION_LEAD" },
    { id: UUID_MEMBER, email: "member@ct.test", display_name: "Member", role: "TEAM_MEMBER" },
  ]);
  return db;
}

const authApi: AuthApi = {
  async getUser(token) {
    if (token === "jwt-lead") return { id: UUID_LEAD, email: "lead@ct.test" };
    if (token === "jwt-member") return { id: UUID_MEMBER, email: "member@ct.test" };
    if (token === "jwt-unknown") return { id: "33333333-3333-4333-8333-333333333333", email: "x@ct.test" };
    return null;
  },
};

describe("gateway HTTP surface", () => {
  const localDeps = (): GatewayDeps => ({
    auth: { verify: async (t) => (t === "good" ? lead : null) },
    store: new OSDataGatewayStore(createJob(base(), { projectId: "proj_uproof", agentId: "agent_08", instructions: "x", id: "job_1" }).data, ROLES_BY_ID),
    router: new ModelRouter({ registry: new ProviderRegistry([new StubProvider({ id: "claude" })]) }),
    mode: "local",
  });

  it("extracts bearer tokens and answers CORS preflight", async () => {
    expect(bearerToken({ authorization: "Bearer abc.def" })).toBe("abc.def");
    expect(bearerToken({ Authorization: "bearer xyz" })).toBe("xyz");
    expect(bearerToken({})).toBeNull();
    const pre = await handleGatewayHttp({ method: "OPTIONS", path: "/agent-execute", headers: {}, body: null }, localDeps());
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("direct calls without a valid session are rejected with 401", async () => {
    const res = await handleGatewayHttp({ method: "POST", path: "/agent-execute", headers: {}, body: { jobId: "job_1" } }, localDeps());
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false, code: "unauthenticated" });
    const bad = await handleGatewayHttp({ method: "POST", path: "/agent-execute", headers: { authorization: "Bearer forged" }, body: { jobId: "job_1" } }, localDeps());
    expect(bad.status).toBe(401);
  });

  it("validates the body and routes health / execute", async () => {
    const deps = localDeps();
    expect((await handleGatewayHttp({ method: "POST", path: "/agent-execute", headers: { authorization: "Bearer good" }, body: {} }, deps)).status).toBe(400);
    expect((await handleGatewayHttp({ method: "PUT", path: "/agent-execute", headers: { authorization: "Bearer good" }, body: {} }, deps)).status).toBe(405);
    const health = await handleGatewayHttp({ method: "GET", path: "/agent-execute/health", headers: { authorization: "Bearer good" }, body: null }, deps);
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, mode: "local" });
    const run = await handleGatewayHttp({ method: "POST", path: "/agent-execute", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: { jobId: "job_1" } }, deps);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ ok: true, result: { status: "COMPLETED", provider: "claude" } });
    expect(run.headers["content-type"]).toBe("application/json");
  });
});

describe("Supabase-backed gateway store and auth", () => {
  it("verifies a JWT through the auth API and resolves the role from profiles", async () => {
    const auth = new SupabaseGatewayAuth(authApi, fakeDbFromSeed());
    expect(await auth.verify(null)).toBeNull();
    expect(await auth.verify("nope")).toBeNull();
    expect(await auth.verify("jwt-lead")).toEqual({ id: UUID_LEAD, email: "lead@ct.test", displayName: "Lead", role: "PRODUCTION_LEAD", active: true });
    // A user without a profile row is a VIEWER — never elevated by default.
    expect((await auth.verify("jwt-unknown"))?.role).toBe("VIEWER");
  });

  it("rejects an inactive account independently of role — the gateway never trusts the UI for this (CTOS-002A)", async () => {
    const db = fakeDbFromSeed();
    // A self-registered sign-up with no matching invite: created, but inactive. Give it a role to
    // prove activation is checked separately from role — an inactive ADMIN is still refused.
    db.seed("profiles", [{ id: UUID_MEMBER, email: "member@ct.test", display_name: "Member", role: "ADMIN", active: false }]);
    const auth = new SupabaseGatewayAuth(authApi, db);
    expect(await auth.verify("jwt-member")).toBeNull();

    // Same account through the full HTTP surface: 401, not merely "denied by permission".
    const store = new SupabaseGatewayStore(db);
    const deps: GatewayDeps = { auth, store, router: new ModelRouter({ registry: new ProviderRegistry([new StubProvider({ id: "claude" })]) }), mode: "supabase" };
    const res = await handleGatewayHttp({ method: "POST", path: "/agent-execute", headers: { authorization: "Bearer jwt-member" }, body: { jobId: "job_db" } }, deps);
    expect(res.status).toBe(401);
  });

  it("loads job context from tables, enforces AMBER with the approver role from profiles, and commits records", async () => {
    const { data, job } = createJob(base(), { projectId: "proj_uproof", agentId: "agent_05", instructions: "Build the header", id: "job_db", requestedById: UUID_MEMBER });
    const db = fakeDbFromSeed(data);
    const store = new SupabaseGatewayStore(db);
    const ctx = await store.loadJobContext("job_db");
    expect(ctx?.job.id).toBe("job_db");
    expect(ctx?.agent.code).toBe("A05");
    expect(ctx?.knowledge.every((k) => k.status === "APPROVED")).toBe(true);
    expect(ctx?.knowledge.filter((k) => k.scope === "DOCTRINE").length).toBe(4);
    expect(await store.getUserRole(UUID_LEAD)).toBe("PRODUCTION_LEAD");
    expect(await store.getUserRole("nobody")).toBeNull();

    const deps: GatewayDeps = { auth: new SupabaseGatewayAuth(authApi, db), store, router: new ModelRouter({ registry: new ProviderRegistry([new StubProvider({ id: "claude" }), new StubProvider({ id: "openai" })]) }), mode: "supabase" };
    // AMBER without approval → 403, logged in execution_logs.
    const denied = await handleGatewayHttp({ method: "POST", path: "/agent-execute", headers: { authorization: "Bearer jwt-member" }, body: { jobId: "job_db" } }, deps);
    expect(denied.status).toBe(403);
    expect((await db.select("execution_logs", [{ column: "job_id", op: "eq", value: "job_db" }]))[0]).toMatchObject({ status: "REJECTED" });

    // Approval forged with a fake role on the row: the gateway re-reads profiles → still denied.
    await db.upsert("job_approvals", [
      toRow({ id: "ja1", jobId: "job_db", projectId: "proj_uproof", agentId: "agent_05", kind: "APPROVAL", permissionLevel: "AMBER", actionFingerprint: (await import("@/services/job-approvals")).actionFingerprint(job), requestedAction: "x", requestedById: UUID_MEMBER, requestedByName: "Member", approvedById: UUID_MEMBER, approvedByName: "Member", approvedByRole: "ADMIN", status: "APPROVED", createdAt: null, decidedAt: null, consumedAt: null, expiresAt: null }),
    ]);
    expect((await handleGatewayHttp({ method: "POST", path: "/agent-execute", headers: { authorization: "Bearer jwt-member" }, body: { jobId: "job_db" } }, deps)).status).toBe(403);

    // Real approval by the lead → executes, commits runs/artifact/logs, consumes the approval.
    await db.upsert("job_approvals", [{ ...(await db.select("job_approvals", [{ column: "id", op: "eq", value: "ja1" }]))[0], approved_by_id: UUID_LEAD, approved_by_name: "Lead", approved_by_role: "PRODUCTION_LEAD" }]);
    const ok = await handleGatewayHttp({ method: "POST", path: "/agent-execute", headers: { authorization: "Bearer jwt-member" }, body: { jobId: "job_db" } }, deps);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, result: { status: "COMPLETED", provider: "claude" }, permission: { level: "AMBER", outcome: "allowed", approvalId: "ja1" } });
    expect((await db.select("agent_jobs", [{ column: "id", op: "eq", value: "job_db" }]))[0]).toMatchObject({ status: "WAITING_APPROVAL" });
    expect((await db.select("job_approvals", [{ column: "id", op: "eq", value: "ja1" }]))[0]).toMatchObject({ status: "CONSUMED" });
    const artifacts = await db.select("artifacts", [{ column: "job_id", op: "eq", value: "job_db" }]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ type: "build_report", created_by_agent_id: "agent_05", created_by_provider: "claude", status: "DRAFT" });
    const runs = await db.select("agent_runs", [{ column: "job_id", op: "eq", value: "job_db" }]);
    expect(runs.map((r) => `${r.provider_id}:${r.status}`)).toEqual(["claude:SUCCEEDED"]);
    const logs = await db.select("execution_logs", [{ column: "job_id", op: "eq", value: "job_db" }]);
    expect(logs.map((l) => l.status)).toEqual(["REJECTED", "REJECTED", "COMPLETED"]);
    expect(JSON.stringify(logs)).not.toMatch(/jwt-|Bearer/);
  });
});

describe("structured output schemas", () => {
  it("every schema validates its example and rejects garbage with path-level issues", () => {
    for (const name of Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[]) {
      expect(validateOutput(name, EXAMPLES[name]).ok, name).toBe(true);
      const bad = validateOutput(name, { nonsense: true });
      expect(bad.ok).toBe(false);
      expect(bad.issues[0].path).toBeTruthy();
    }
    expect(validateOutput("site_blueprint@9", {}).issues[0].message).toMatch(/Unknown output schema/);
    expect(validateOutput("qa_report@1", { ...(EXAMPLES["qa_report@1"] as object), counts: { P0: -1, P1: 0, P2: 0, P3: 0 } }).issues[0].path).toBe("counts.P0");
  });

  it("exports JSON Schema for providers that accept one", () => {
    const js = jsonSchemaFor("qa_report@1") as { type: string; required?: string[]; properties: Record<string, unknown> };
    expect(js.type).toBe("object");
    expect(js.required).toContain("defects");
    expect(Object.keys(js.properties)).toEqual(["summary", "result", "defects", "counts", "readyForHumanReview"]);
  });
});

describe("auth backends", () => {
  it("local mode issues a named identity with a chosen role and a local session token", async () => {
    const backend = new LocalAuthBackend();
    expect(await backend.getSession()).toBeNull();
    const s = await backend.signIn({ displayName: "Richard Strauss", role: "PRODUCTION_LEAD" });
    expect(s.user).toEqual({ id: "local_richard-strauss", email: null, displayName: "Richard Strauss", role: "PRODUCTION_LEAD", active: true });
    expect(s.token).toBe("local-session");
    await expect(backend.signIn({ email: "a@b", password: "x" })).rejects.toThrow(/name and role/);
    await backend.signOut();
    expect(await backend.getSession()).toBeNull();
    void member;
  });

  it("Supabase mode reads active straight from the profiles row — false blocks the app, a missing column/row does not (CTOS-002A)", async () => {
    function fakeClient(profile: Record<string, unknown> | null): SupabaseAuthClientLike {
      const session = { access_token: "tok", user: { id: "u1", email: "u1@ct.test" } };
      return {
        auth: {
          async getSession() {
            return { data: { session } };
          },
          async signInWithPassword() {
            return { data: { session }, error: null };
          },
          async signOut() {
            return { error: null };
          },
          onAuthStateChange() {
            return { data: { subscription: { unsubscribe() {} } } };
          },
        },
        from() {
          return { select: () => ({ eq: () => ({ async maybeSingle() { return { data: profile, error: null }; } }) }) };
        },
      };
    }

    // A pending self-registration: profile row exists, active is explicitly false.
    const pending = new SupabaseAuthBackend(fakeClient({ display_name: "Pending Person", role: "VIEWER", active: false }));
    expect((await pending.getSession())?.user.active).toBe(false);

    // A normal, approved account.
    const active = new SupabaseAuthBackend(fakeClient({ display_name: "Approved Person", role: "TEAM_MEMBER", active: true }));
    expect((await active.getSession())?.user.active).toBe(true);

    // No profile row at all (shouldn't happen — the trigger always inserts one — but must fail safe
    // toward "don't block a real account over a missing column", not silently grant more than VIEWER).
    const noProfile = new SupabaseAuthBackend(fakeClient(null));
    const s = await noProfile.getSession();
    expect(s?.user.active).toBe(true);
    expect(s?.user.role).toBe("VIEWER");
  });
});

describe("Supabase gateway store — write order and one-shot consumption", () => {
  it("commits in foreign-key order (artifact before job) and consumes an approval exactly once", async () => {
    const { data, job } = createJob(base(), { projectId: "proj_uproof", agentId: "agent_08", instructions: "x", id: "job_fk", requestedById: UUID_LEAD });
    const db = fakeDbFromSeed(data);
    const order: string[] = [];
    const origUpsert = db.upsert.bind(db);
    const origUpdate = db.updateWhere.bind(db);
    db.upsert = async (t, rows) => {
      order.push(`upsert:${t}`);
      return origUpsert(t, rows);
    };
    db.updateWhere = async (t, patch, filters) => {
      order.push(`update:${t}`);
      return origUpdate(t, patch, filters);
    };
    const store = new SupabaseGatewayStore(db);
    // Pretend the job needs an approval that exists, to exercise consumption.
    await db.upsert("job_approvals", [toRow({ id: "ja_fk", jobId: job.id, projectId: job.projectId, agentId: job.agentId, kind: "APPROVAL", permissionLevel: "AMBER", actionFingerprint: "fp", requestedAction: "x", requestedById: UUID_LEAD, requestedByName: "Lead", approvedById: UUID_LEAD, approvedByName: "Lead", approvedByRole: "PRODUCTION_LEAD", status: "APPROVED", createdAt: null, decidedAt: null, consumedAt: null, expiresAt: null })]);
    order.length = 0;
    const ctx = (await store.loadJobContext("job_fk"))!;
    await store.commit({ job: { ...ctx.job, status: "WAITING_APPROVAL", outputArtifactId: "art_fk" }, runs: [{ id: "run_fk", jobId: "job_fk", projectId: "proj_uproof", agentId: "agent_08", providerId: "claude", model: null, attempt: 1, status: "SUCCEEDED", errorCategory: null, validation: null, latencyMs: 1, inputTokens: null, outputTokens: null, startedAt: null, finishedAt: null }], artifact: { id: "art_fk", projectId: "proj_uproof", type: "lesson_candidate", title: "t", version: 1, createdByAgentId: "agent_08", createdByProvider: "claude", jobId: "job_fk", status: "DRAFT", storageLocation: null, schemaVersion: 1, supersedesArtifactId: null, createdAt: null, updatedAt: null }, supersededArtifactId: null, handoff: null, approval: { ...ctx.approvals[0], status: "CONSUMED", consumedAt: "2026-09-08T00:00:00Z" }, logs: [] });
    expect(order.indexOf("upsert:artifacts")).toBeLessThan(order.indexOf("upsert:agent_runs"));
    expect(order.indexOf("upsert:agent_runs")).toBeLessThan(order.indexOf("upsert:agent_jobs"));
    expect(order).toContain("update:job_approvals");
    expect((await db.select("job_approvals", [{ column: "id", op: "eq", value: "ja_fk" }]))[0].status).toBe("CONSUMED");
    // Second consumption of the same approval is refused.
    await expect(store.commit({ job: ctx.job, runs: [], artifact: null, supersededArtifactId: null, handoff: null, approval: { ...ctx.approvals[0], status: "CONSUMED", consumedAt: "x" }, logs: [] })).rejects.toThrow(/already consumed/);
    // The lease is atomic: a second claim while one is live is refused.
    expect(await store.claimJob("job_fk", "c1", 60_000)).toBe(true);
    expect(await store.claimJob("job_fk", "c2", 60_000)).toBe(false);
    await store.releaseJob("job_fk", "c1");
    expect(await store.claimJob("job_fk", "c2", 60_000)).toBe(true);
  });
});

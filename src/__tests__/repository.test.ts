import { describe, expect, it } from "vitest";
import { productionBootstrapData, seedData } from "@/data/seed";
import { InMemoryRepository, createRepository } from "@/services/repository";
import { FakeSupabaseClient, SupabaseRepository, stable } from "@/services/supabase/repository";
import { TABLES, fromRow, toRow } from "@/services/supabase/mapping";
import type { OSData } from "@/data/types";
import { createArtifact } from "@/services/artifacts";

describe("repository compatibility", () => {
  it("in-memory repository loads the seed and persists a snapshot for the session", () => {
    const repo = new InMemoryRepository();
    const data = repo.load();
    expect(data.projects[0].id).toBe("proj_uproof");
    expect(data).not.toBe(seedData); // cloned, never mutates the seed constant
    const next = { ...data, activity: [] };
    repo.persist(next);
    expect(repo.load().activity.length).toBe(0);
    expect(seedData.activity.length).toBeGreaterThan(0);
  });

  it("every OSData collection has a table spec and rows round-trip exactly", () => {
    const keys = Object.keys(seedData) as (keyof OSData)[];
    for (const key of keys) expect(TABLES.some((t) => t.key === key), `table for ${key}`).toBe(true);
    for (const spec of TABLES) {
      for (const entity of seedData[spec.key] as object[]) {
        const back = fromRow(spec, toRow(entity));
        expect(stable(back), `${spec.table}:${(entity as { id: string }).id}`).toBe(stable(entity));
      }
    }
  });

  it("CTOS-008B: Supabase repository bootstraps CLEAN production data for an empty database — never the seedData demo", async () => {
    const client = new FakeSupabaseClient();
    const repo = new SupabaseRepository({ client });
    const loaded = await repo.load();
    expect(repo.bootstrapped).toBe(true);
    // Bootstraps the clean dataset, not the full U-Proof demo.
    expect(stable(loaded)).toBe(stable(productionBootstrapData));
    expect(stable(loaded)).not.toBe(stable(seedData));

    await repo.persist(loaded);
    // No demo client/project/ticket/artifact/QA/launch-hold/approval/activity/audit history at all.
    expect(client.tables.get("clients")?.size ?? 0).toBe(0);
    expect(client.tables.get("projects")?.size ?? 0).toBe(0);
    expect(client.tables.get("tickets")?.size ?? 0).toBe(0);
    expect(client.tables.get("artifacts")?.size ?? 0).toBe(0);
    expect(client.tables.get("qa_items")?.size ?? 0).toBe(0);
    expect(client.tables.get("launch_holds")?.size ?? 0).toBe(0);
    expect(client.tables.get("approvals")?.size ?? 0).toBe(0);
    expect(client.tables.get("activity_events")?.size ?? 0).toBe(0);
    expect(client.tables.get("agent_lessons")?.size ?? 0).toBe(0);
    expect(client.tables.get("website_audit_requests")?.size ?? 0).toBe(0);
    expect(client.tables.get("audit_findings")?.size ?? 0).toBe(0);
    // No AGENCY lesson candidates (they cite fictional CT-UP-* U-Proof tickets) — only DOCTRINE survives.
    expect(loaded.knowledgeItems.every((k) => k.scope === "DOCTRINE")).toBe(true);
    expect(loaded.knowledgeItems.length).toBeGreaterThan(0);

    // But the system/reference data every project needs IS present: agent roster, gates, skills, integrations.
    expect(client.tables.get("agents")?.size).toBe(9);
    expect(client.tables.get("gates")?.size).toBe(seedData.gates.length);
    expect(client.tables.get("skills")?.size).toBe(seedData.skills.length);
    expect(client.tables.get("integrations")?.size).toBe(seedData.integrations.length);
    const agentRow = client.tables.get("agents")?.get("agent_02");
    expect(agentRow?.provider_policy).toEqual({ preferred: "claude", fallbacks: ["openai"], reviewer: "gemini" });
    expect(agentRow?.created_at).toBeNull();

    // A second repository against the same "database" loads the identical (still clean) dataset.
    const repo2 = new SupabaseRepository({ client });
    const reloaded = await repo2.load();
    expect(repo2.bootstrapped).toBe(false);
    expect(stable(reloaded)).toBe(stable(productionBootstrapData));
  });

  it("CTOS-008B: a test/demo may still explicitly bootstrap SupabaseRepository with the seedData U-Proof demo", async () => {
    const client = new FakeSupabaseClient();
    const repo = new SupabaseRepository({ client, seed: seedData });
    const loaded = await repo.load();
    expect(stable(loaded)).toBe(stable(seedData));
    await repo.persist(loaded);
    expect(client.tables.get("projects")?.size).toBe(1);
    expect(client.tables.get("projects")?.get("proj_uproof")).toBeTruthy();
  });

  it("Supabase repository writes only the diff and deletes removed rows", async () => {
    const client = new FakeSupabaseClient();
    const repo = new SupabaseRepository({ client });
    const data = await repo.load();
    await repo.persist(data);
    client.log.length = 0;

    const { data: next } = createArtifact(data, { projectId: "proj_uproof", type: "build_plan", title: "Plan", createdByAgentId: "agent_orch" });
    await repo.persist(next);
    expect(client.log).toEqual([{ op: "upsert", table: "artifacts", count: 1 }]);

    client.log.length = 0;
    const removed = { ...next, artifacts: next.artifacts.slice(0, -1) };
    await repo.persist(removed);
    expect(client.log).toEqual([{ op: "delete", table: "artifacts", count: 1 }]);

    client.log.length = 0;
    await repo.persist(removed);
    expect(client.log).toEqual([]);
  });

  it("CTOS-008: a WordPress site connection with the new CT Bridge / WooCommerce status fields round-trips", () => {
    const spec = TABLES.find((t) => t.table === "wp_site_connections")!;
    const conn = {
      id: "wsc_1", projectId: "proj_uproof", siteUrl: "https://uproof.co.za", environment: "PRODUCTION",
      cms: "WORDPRESS", builder: "ELEMENTOR_PRO", authMethod: "ct_bridge", credentialsRef: null,
      connectionStatus: "ONLINE", lastVerifiedAt: null, capabilities: ["read_content"], writeable: true,
      ownershipNote: null, hostProvider: "Hostinger", hostReplaceable: true,
      ctBridgeStatus: "CONNECTED", wooCommerceStatus: "ACTIVE",
      createdAt: null, updatedAt: null,
    };
    const back = fromRow<typeof conn>(spec, toRow(conn));
    expect(back.ctBridgeStatus).toBe("CONNECTED");
    expect(back.wooCommerceStatus).toBe("ACTIVE");
    expect(stable(back)).toBe(stable(conn));
  });

  it("CTOS-008B: local/in-memory dev still gets the full seedData demo by default — only the Supabase default changed", async () => {
    const mem = new InMemoryRepository().load();
    expect(stable(mem)).toBe(stable(seedData));
    expect(mem.projects[0]?.id).toBe("proj_uproof");
    // Confirms the two repositories now deliberately diverge on an empty backing store.
    const sb = await new SupabaseRepository({ client: new FakeSupabaseClient() }).load();
    expect(stable(sb)).not.toBe(stable(mem));
    expect(sb.projects).toHaveLength(0);
  });

  it("createRepository falls back to memory without credentials and picks supabase with them", async () => {
    const none = await createRepository({});
    expect(none.repository.kind).toBe("memory");
    const forced = await createRepository({ VITE_CTOS_REPOSITORY: "supabase" });
    expect(forced.repository.kind).toBe("memory");
    expect(forced.reason).toMatch(/not set/);
    const memory = await createRepository({ VITE_CTOS_REPOSITORY: "memory", VITE_SUPABASE_URL: "https://x.supabase.co", VITE_SUPABASE_ANON_KEY: "k" });
    expect(memory.repository.kind).toBe("memory");
    const sb = await createRepository({ VITE_SUPABASE_URL: "https://example.supabase.co", VITE_SUPABASE_ANON_KEY: "anon" });
    expect(sb.repository.kind).toBe("supabase");
    expect(sb.reason).toContain("example.supabase.co");
  });
});

describe("Supabase repository resilience (review fixes)", () => {
  it("a failed write does not poison the queue and is retried in full next time", async () => {
    const client = new FakeSupabaseClient();
    let fail = false;
    const flaky: typeof client = Object.assign(Object.create(Object.getPrototypeOf(client)), client, {
      from(table: string) {
        const q = FakeSupabaseClient.prototype.from.call(client, table);
        return { ...q, upsert: async (rows: Parameters<typeof q.upsert>[0], o?: Parameters<typeof q.upsert>[1]) => (fail ? { data: null, error: { message: "boom" } } : q.upsert(rows, o)) };
      },
    });
    const repo = new SupabaseRepository({ client: flaky });
    const data = await repo.load();
    await repo.persist(data);
    fail = true;
    const { data: next } = createArtifact(data, { projectId: "proj_uproof", type: "build_plan", title: "Plan", createdByAgentId: "agent_orch" });
    await expect(repo.persist(next)).rejects.toThrow(/boom/);
    expect(repo.lastError).toMatch(/boom/);
    fail = false;
    await repo.persist(next);
    expect(repo.lastError).toBeNull();
    expect(client.tables.get("artifacts")?.size).toBe(productionBootstrapData.artifacts.length + 1);
  });
});

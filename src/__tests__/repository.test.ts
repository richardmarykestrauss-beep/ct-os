import { describe, expect, it } from "vitest";
import { seedData } from "@/data/seed";
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

  it("Supabase repository bootstraps an empty database from the seed and then persists it", async () => {
    const client = new FakeSupabaseClient();
    const repo = new SupabaseRepository({ client });
    const loaded = await repo.load();
    expect(repo.bootstrapped).toBe(true);
    expect(stable(loaded)).toBe(stable(seedData));
    await repo.persist(loaded);
    expect(client.tables.get("projects")?.size).toBe(1);
    expect(client.tables.get("knowledge_items")?.size).toBe(seedData.knowledgeItems.length);
    expect(client.tables.get("agents")?.size).toBe(9);
    // Row shape is snake_case and nested policy is preserved as JSON.
    const agentRow = client.tables.get("agents")?.get("agent_02");
    expect(agentRow?.provider_policy).toEqual({ preferred: "claude", fallbacks: ["openai"], reviewer: "gemini" });
    expect(agentRow?.created_at).toBeNull();

    // A second repository against the same "database" loads the identical dataset.
    const repo2 = new SupabaseRepository({ client });
    const reloaded = await repo2.load();
    expect(repo2.bootstrapped).toBe(false);
    expect(stable(reloaded)).toBe(stable(seedData));
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

  it("in-memory and Supabase repositories expose the same OSData to the store", async () => {
    const mem = new InMemoryRepository().load();
    const sb = await new SupabaseRepository({ client: new FakeSupabaseClient() }).load();
    expect(stable(sb)).toBe(stable(mem));
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
    expect(client.tables.get("artifacts")?.size).toBe(seedData.artifacts.length + 1);
  });
});

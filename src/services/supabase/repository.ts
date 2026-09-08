/**
 * SupabaseRepository — persistent implementation of OSRepository.
 *
 * Design:
 *  - `load()` reads every table and assembles OSData. If the database is empty (no projects),
 *    it returns the seed so U-Proof stays usable; the first `persist()` then writes it.
 *  - `persist(data)` diffs the snapshot against the last known database state and only upserts
 *    changed/new rows (and deletes removed ids). Writes are serialised and coalesced so bursts
 *    of reducer actions become one round of writes.
 *  - It talks to a narrow `SupabaseClientLike` interface, so the real `@supabase/supabase-js`
 *    client and a test fake are interchangeable. No other module imports the SDK.
 */
import type { OSData } from "@/data/types";
import { seedData } from "@/data/seed";
import type { OSRepository } from "../repository";
import { TABLES, fromRow, toRow, type Row, type TableName, type TableSpec } from "./mapping";

// Narrow structural type — matches the subset of PostgREST client we use.
export interface SupabaseResult<T> {
  data: T | null;
  error: { message: string } | null;
}
export interface SupabaseQuery {
  select(columns: string): PromiseLike<SupabaseResult<Row[]>>;
  upsert(rows: Row[], options?: { onConflict?: string }): PromiseLike<SupabaseResult<unknown>>;
  delete(): { in(column: string, values: string[]): PromiseLike<SupabaseResult<unknown>> };
}
export interface SupabaseClientLike {
  from(table: string): SupabaseQuery;
}

export interface SupabaseRepositoryOptions {
  client: SupabaseClientLike;
  /** Seed to bootstrap an empty database. Defaults to the U-Proof seed. */
  seed?: OSData;
  /** Chunk size for upserts. */
  batchSize?: number;
  /** Called after each persist with what was written (for Settings/diagnostics). */
  onPersist?: (summary: PersistSummary) => void;
}

export interface PersistSummary {
  upserted: Partial<Record<TableName, number>>;
  deleted: Partial<Record<TableName, number>>;
  at: string;
}

export class SupabaseRepository implements OSRepository {
  readonly kind = "supabase" as const;
  private readonly client: SupabaseClientLike;
  private readonly seed: OSData;
  private readonly batchSize: number;
  private readonly onPersist?: (summary: PersistSummary) => void;
  /** Last state known to be in the database, keyed per table by row id → JSON. */
  private known = new Map<TableName, Map<string, string>>();
  private queue: Promise<void> = Promise.resolve();
  private pending: OSData | null = null;
  lastError: string | null = null;
  bootstrapped = false;

  constructor(opts: SupabaseRepositoryOptions) {
    this.client = opts.client;
    this.seed = opts.seed ?? seedData;
    this.batchSize = opts.batchSize ?? 200;
    this.onPersist = opts.onPersist;
  }

  describe() {
    return this.bootstrapped ? "Supabase (seeded this session)" : "Supabase";
  }

  async load(): Promise<OSData> {
    const data = {} as Record<keyof OSData, unknown[]>;
    const known = new Map<TableName, Map<string, string>>();
    for (const spec of TABLES) {
      const res = await this.client.from(spec.table).select("*");
      if (res.error) throw new Error(`Supabase load ${spec.table}: ${res.error.message}`);
      const rows = res.data ?? [];
      data[spec.key] = rows.map((r) => fromRow(spec, r));
      known.set(spec.table, new Map(rows.map((r) => [String(r.id), stable(fromRow(spec, r))])));
    }
    this.known = known;
    const loaded = data as unknown as OSData;
    if (loaded.projects.length === 0) {
      // Empty database: bootstrap from seed. `known` stays empty so persist() writes everything.
      this.bootstrapped = true;
      return structuredClone(this.seed);
    }
    return loaded;
  }

  /** Coalesce: if several persists arrive while one is in flight, only the latest snapshot is written next. */
  persist(data: OSData): Promise<void> {
    this.pending = data;
    // `.catch` first so one failed write never poisons the queue for later persists.
    this.queue = this.queue.catch(() => undefined).then(async () => {
      const next = this.pending;
      this.pending = null;
      if (!next) return;
      try {
        await this.write(next);
        this.lastError = null;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      }
    });
    return this.queue;
  }

  /** Flush for tests / shutdown. */
  async flush() {
    await this.queue;
  }

  private async write(data: OSData) {
    const summary: PersistSummary = { upserted: {}, deleted: {}, at: new Date().toISOString() };
    const deletes: { spec: TableSpec; ids: string[] }[] = [];
    // `known` is only advanced once every upsert AND delete has succeeded, so a failed round is retried in full.
    const nextKnown = new Map<TableName, Map<string, string>>();
    for (const spec of TABLES) {
      const rows = (data[spec.key] as object[]) ?? [];
      if (spec.serverOwned) {
        // The gateway writes these with the service role; the client only mirrors what it was given.
        nextKnown.set(spec.table, new Map(rows.map((e) => [String((e as { id: string }).id), stable(e)])));
        continue;
      }
      const prev = this.known.get(spec.table) ?? new Map<string, string>();
      const next = new Map<string, string>();
      const changed: Row[] = [];
      for (const entity of rows) {
        const id = String((entity as { id: string }).id);
        const json = stable(entity);
        next.set(id, json);
        if (prev.get(id) !== json) changed.push(toRow(entity));
      }
      const removed = [...prev.keys()].filter((id) => !next.has(id));
      if (changed.length) {
        for (let i = 0; i < changed.length; i += this.batchSize) {
          const res = await this.client.from(spec.table).upsert(changed.slice(i, i + this.batchSize), { onConflict: "id" });
          if (res.error) throw new Error(`Supabase upsert ${spec.table}: ${res.error.message}`);
        }
        summary.upserted[spec.table] = changed.length;
      }
      if (removed.length) deletes.push({ spec, ids: removed });
      nextKnown.set(spec.table, next);
    }
    // Deletes in reverse dependency order.
    for (const { spec, ids } of deletes.reverse()) {
      const res = await this.client.from(spec.table).delete().in("id", ids);
      if (res.error) throw new Error(`Supabase delete ${spec.table}: ${res.error.message}`);
      summary.deleted[spec.table] = ids.length;
    }
    this.known = nextKnown;
    this.bootstrapped = false;
    this.onPersist?.(summary);
  }
}

/** Deterministic JSON (sorted keys) so diffing ignores key order. `undefined` values are dropped. */
export function stable(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** In-memory fake of the PostgREST surface we use — for tests and offline demos. */
export class FakeSupabaseClient implements SupabaseClientLike {
  readonly tables = new Map<string, Map<string, Row>>();
  readonly log: { op: "select" | "upsert" | "delete"; table: string; count: number }[] = [];

  from(table: string): SupabaseQuery {
    const store = this.tables.get(table) ?? new Map<string, Row>();
    this.tables.set(table, store);
    const log = this.log;
    return {
      select: async () => {
        log.push({ op: "select", table, count: store.size });
        return { data: [...store.values()].map((r) => structuredClone(r)), error: null };
      },
      upsert: async (rows) => {
        for (const r of rows) store.set(String(r.id), structuredClone(r));
        log.push({ op: "upsert", table, count: rows.length });
        return { data: null, error: null };
      },
      delete: () => ({
        in: async (_column, values) => {
          for (const v of values) store.delete(v);
          log.push({ op: "delete", table, count: values.length });
          return { data: null, error: null };
        },
      }),
    };
  }
}

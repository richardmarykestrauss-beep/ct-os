/**
 * Repository seam.
 *
 * The UI never talks to a backend directly; it talks to the OS store, which loads/saves through an
 * OSRepository. InMemoryRepository is the local/testing fallback; SupabaseRepository is the
 * persistent implementation. Which one runs is decided by `createRepository()` from the environment.
 */
import type { OSData } from "@/data/types";
import { seedData } from "@/data/seed";

export interface OSRepository {
  readonly kind: "memory" | "supabase";
  /** Load the full dataset (memory: synchronous; supabase: async fetch). */
  load(): Promise<OSData> | OSData;
  /** Persist a snapshot. In-memory implementation keeps it for the session only. */
  persist(data: OSData): Promise<void> | void;
  /** Short human description for Settings. */
  describe?(): string;
}

export class InMemoryRepository implements OSRepository {
  readonly kind = "memory" as const;
  private snapshot: OSData;
  constructor(initial: OSData = seedData) {
    // structuredClone so seed constants are never mutated.
    this.snapshot = structuredClone(initial);
  }
  describe() {
    return "In-memory (session only)";
  }
  load() {
    return this.snapshot;
  }
  persist(data: OSData) {
    this.snapshot = data;
  }
}

export { SupabaseRepository } from "./supabase/repository";

export type RepositoryMode = "auto" | "memory" | "supabase";

export interface RepositoryEnv {
  VITE_CTOS_REPOSITORY?: string;
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
}

export interface RepositoryChoice {
  repository: OSRepository;
  mode: RepositoryMode;
  /** Why the choice was made — shown in Settings. */
  reason: string;
}

function readEnv(): RepositoryEnv {
  return ((import.meta as unknown as { env?: RepositoryEnv }).env ?? {}) as RepositoryEnv;
}

/**
 * Decide the repository from the environment. Supabase is only chosen when a URL and anon key are
 * present; otherwise (or when mode = memory) the in-memory repository keeps CT-OS fully usable.
 */
export async function createRepository(env: RepositoryEnv = readEnv()): Promise<RepositoryChoice> {
  const mode = (env.VITE_CTOS_REPOSITORY ?? "auto") as RepositoryMode;
  const url = env.VITE_SUPABASE_URL?.trim();
  const key = env.VITE_SUPABASE_ANON_KEY?.trim();
  if (mode === "memory") return { repository: new InMemoryRepository(), mode, reason: "VITE_CTOS_REPOSITORY=memory" };
  if (!url || !key) {
    if (mode === "supabase") return { repository: new InMemoryRepository(), mode, reason: "VITE_CTOS_REPOSITORY=supabase but VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — running in memory" };
    return { repository: new InMemoryRepository(), mode, reason: "Supabase credentials not configured — running in memory" };
  }
  const { createSupabaseClient } = await import("./supabase/client");
  const { SupabaseRepository } = await import("./supabase/repository");
  return { repository: new SupabaseRepository({ client: createSupabaseClient(url, key) }), mode, reason: `Supabase configured (${new URL(url).host})` };
}

export const defaultRepository: OSRepository = new InMemoryRepository();

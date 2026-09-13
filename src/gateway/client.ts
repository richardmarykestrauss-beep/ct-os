/**
 * Frontend gateway clients.
 *
 *  - HttpGatewayClient: POST /agent-execute with the user's session token. Used whenever CT-OS runs
 *    against Supabase. Provider secrets live on the server; the browser only ever sends a jobId.
 *  - EmbeddedGatewayClient: runs the same gateway core in-process over the in-memory snapshot with
 *    stub providers. Local mode only — there is no secret to protect and no server to call.
 *    It exists so the pipeline (permission check → validation → runs → logs) behaves identically.
 */
import type { AuthUser, OSData } from "@/data/types";
import { ModelRouter } from "@/ai/router";
import { createBrowserRegistry, type ProviderRegistry } from "@/ai/registry";
import { handleExecute, handleHealth, type GatewayFailure, type GatewayResponse, type HealthResponse } from "./core";
import { OSDataGatewayStore } from "./store";

/**
 * Job truth handed to a gateway that has no server-side store of its own (local dev mode).
 * The Supabase gateway ignores it — it always reads the database. Contains no secrets.
 */
export interface ExecutionContext {
  data: OSData;
  user: AuthUser;
}

export interface ExecuteOptions {
  artifactTitle?: string;
  context?: ExecutionContext;
}

export interface GatewayClient {
  readonly kind: "http" | "embedded";
  execute(jobId: string, opts?: ExecuteOptions): Promise<GatewayResponse>;
  health(): Promise<HealthResponse | GatewayFailure>;
}

export class HttpGatewayClient implements GatewayClient {
  readonly kind = "http" as const;
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => Promise<string | null>,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}
  private async headers() {
    const token = await this.getToken();
    return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }
  async execute(jobId: string, opts: ExecuteOptions = {}): Promise<GatewayResponse> {
    try {
      const res = await this.fetchImpl(this.baseUrl, { method: "POST", headers: await this.headers(), body: JSON.stringify({ jobId, artifactTitle: opts.artifactTitle, context: opts.context }) });
      const body = (await res.json().catch(() => null)) as GatewayResponse | null;
      if (body && typeof body === "object" && "ok" in body) return body;
      return { ok: false, code: "internal", message: `Gateway returned ${res.status}`, status: res.status };
    } catch (err) {
      return { ok: false, code: "internal", message: `Gateway unreachable: ${err instanceof Error ? err.message : String(err)}`, status: 0 };
    }
  }
  async health(): Promise<HealthResponse | GatewayFailure> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/health`, { method: "GET", headers: await this.headers() });
      const body = (await res.json().catch(() => null)) as HealthResponse | GatewayFailure | null;
      return body ?? { ok: false, code: "internal", message: `Gateway returned ${res.status}`, status: res.status };
    } catch (err) {
      return { ok: false, code: "internal", message: `Gateway unreachable: ${err instanceof Error ? err.message : String(err)}`, status: 0 };
    }
  }
}

export interface EmbeddedGatewayOptions {
  getData: () => OSData;
  getUser: () => AuthUser | null;
  registry?: ProviderRegistry;
  router?: ModelRouter;
}

export class EmbeddedGatewayClient implements GatewayClient {
  readonly kind = "embedded" as const;
  private readonly router: ModelRouter;
  constructor(private readonly opts: EmbeddedGatewayOptions) {
    this.router = opts.router ?? new ModelRouter({ registry: opts.registry ?? createBrowserRegistry() });
  }
  private deps(context?: ExecutionContext) {
    const user = context?.user ?? this.opts.getUser();
    return {
      auth: { verify: async (token: string | null) => (token === "local-session" && user ? user : null) },
      store: new OSDataGatewayStore(context?.data ?? this.opts.getData(), user ? { [user.id]: user.role } : {}),
      router: this.router,
      mode: "local" as const,
    };
  }
  execute(jobId: string, opts: ExecuteOptions = {}) {
    const user = opts.context?.user ?? this.opts.getUser();
    return handleExecute({ token: user ? "local-session" : null, jobId, artifactTitle: opts.artifactTitle }, this.deps(opts.context));
  }
  health() {
    return handleHealth({ token: this.opts.getUser() ? "local-session" : null }, this.deps());
  }
}

/** Where the HTTP gateway lives: explicit env, else Vite dev middleware in dev, else the Edge Function. */
export function resolveGatewayUrl(env: Record<string, string | boolean | undefined>): string {
  const explicit = typeof env.VITE_CTOS_GATEWAY_URL === "string" ? env.VITE_CTOS_GATEWAY_URL.trim() : "";
  if (explicit) return explicit;
  if (env.DEV) return "/agent-execute";
  const supabaseUrl = typeof env.VITE_SUPABASE_URL === "string" ? env.VITE_SUPABASE_URL.replace(/\/$/, "") : "";
  return supabaseUrl ? `${supabaseUrl}/functions/v1/agent-execute` : "/agent-execute";
}

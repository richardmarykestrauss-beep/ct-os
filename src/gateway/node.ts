/**
 * Node runtime wrapper for the gateway — used by the Vite dev middleware (`npm run dev`).
 *
 * Reads server-only secrets from the process environment / .env.local (never VITE_-prefixed, so
 * Vite can never inline them into the browser bundle) and serves the same core the Edge Function runs.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthUser, OSData } from "@/data/types";
import { createServerRegistry, type ServerEnv } from "@/ai/registry";
import { ModelRouter } from "@/ai/router";
import { EMPTY, type GatewayDeps } from "./core";
import { handleGatewayHttp } from "./http";
import { OSDataGatewayStore } from "./store";
import { SupabaseGatewayAuth, SupabaseGatewayStore, supabaseAuthApi, supabaseDb, type SupabaseServiceClientLike } from "./supabase";

export interface NodeGatewayConfig {
  env: ServerEnv;
  /** Injectable for tests. */
  createClient?: (url: string, serviceRoleKey: string) => Promise<SupabaseServiceClientLike>;
  log?: (event: Record<string, unknown>) => void;
}

export function gatewayConfigProblem(env: ServerEnv): string | null {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) return "SUPABASE_URL (or VITE_SUPABASE_URL) is not set";
  if (!key) return "SUPABASE_SERVICE_ROLE_KEY is not set (server-side only — never VITE_-prefixed)";
  return null;
}

async function defaultCreateClient(url: string, key: string): Promise<SupabaseServiceClientLike> {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as SupabaseServiceClientLike;
}

export async function createNodeGatewayDeps(config: NodeGatewayConfig): Promise<GatewayDeps> {
  const problem = gatewayConfigProblem(config.env);
  if (problem) throw new Error(problem);
  const url = (config.env.SUPABASE_URL ?? config.env.VITE_SUPABASE_URL)!;
  const client = await (config.createClient ?? defaultCreateClient)(url, config.env.SUPABASE_SERVICE_ROLE_KEY!);
  const db = supabaseDb(client);
  return {
    auth: new SupabaseGatewayAuth(supabaseAuthApi(client), db),
    store: new SupabaseGatewayStore(db),
    router: new ModelRouter({ registry: createServerRegistry(config.env) }),
    mode: "supabase",
    log: config.log ?? ((e) => console.log("[ctos-gateway]", JSON.stringify(e))),
  };
}

/** Node (req, res) handler. Builds deps once and reuses them. */
export function createNodeGatewayHandler(config: NodeGatewayConfig) {
  let depsPromise: Promise<GatewayDeps> | null = null;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, headers: Record<string, string>, body: unknown) => {
      res.writeHead(status, headers);
      res.end(body === null || body === undefined ? undefined : JSON.stringify(body));
    };
    const problem = gatewayConfigProblem(config.env);
    if (problem) return send(503, { "content-type": "application/json", "access-control-allow-origin": "*" }, { ok: false, code: "internal", message: `Gateway not configured: ${problem}. Local mode uses the embedded gateway with stub providers.`, status: 503 });
    depsPromise ??= createNodeGatewayDeps(config);
    let deps: GatewayDeps;
    try {
      deps = await depsPromise;
    } catch (err) {
      depsPromise = null;
      return send(503, { "content-type": "application/json" }, { ok: false, code: "internal", message: `Gateway failed to start: ${err instanceof Error ? err.message : String(err)}`, status: 503 });
    }
    const body = req.method === "POST" ? await readJson(req) : null;
    const out = await handleGatewayHttp({ method: req.method ?? "GET", path: req.url ?? "/", headers: lowerHeaders(req.headers), body }, deps);
    send(out.status, out.headers, out.body);
  };
}

/**
 * Local-mode gateway (CTOS-007A). Enabled only when `CTOS_LOCAL_NO_SUPABASE=1` and Supabase is NOT
 * configured. There is no server-side job store, so the browser posts the job truth it holds
 * (`context: { data, user }`) and the same gateway core runs it against the live server registry.
 * Everything else — permission enforcement, ModelRouter fallback, validation, runs, execution logs —
 * is identical to the Supabase path. Dev middleware only; never bundled for the browser.
 */
export function localGatewayEnabled(env: ServerEnv): boolean {
  return (env.CTOS_LOCAL_NO_SUPABASE === "1" || env.CTOS_LOCAL_NO_SUPABASE === "true") && gatewayConfigProblem(env) !== null;
}

const LOCAL_MAX_BODY = 4 * 1024 * 1024;

export function createLocalGatewayHandler(config: NodeGatewayConfig) {
  const router = new ModelRouter({ registry: createServerRegistry(config.env) });
  const log = config.log ?? ((e) => console.log("[ctos-gateway:local]", JSON.stringify(e)));
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, headers: Record<string, string>, body: unknown) => {
      res.writeHead(status, headers);
      res.end(body === null || body === undefined ? undefined : JSON.stringify(body));
    };
    const body = req.method === "POST" ? ((await readJson(req, LOCAL_MAX_BODY)) as { context?: { data?: OSData; user?: AuthUser } } | null) : null;
    const context = body?.context;
    const user = context?.user && typeof context.user.id === "string" ? context.user : null;
    const isHealth = req.method === "GET" && (req.url ?? "").includes("/health");
    if (!isHealth && (!context?.data || !user)) {
      return send(400, { "content-type": "application/json" }, { ok: false, code: "bad_request", message: "Local gateway needs { jobId, context: { data, user } }", status: 400 });
    }
    const deps: GatewayDeps = {
      auth: { verify: async (token) => (token === "local-session" ? (user ?? { id: "local", email: null, displayName: "Local", role: "ADMIN" }) : null) },
      store: new OSDataGatewayStore(context?.data ?? EMPTY, user ? { [user.id]: user.role } : {}),
      router,
      mode: "local",
      log,
    };
    const out = await handleGatewayHttp({ method: req.method ?? "GET", path: req.url ?? "/", headers: { ...lowerHeaders(req.headers), authorization: "Bearer local-session" }, body }, deps);
    send(out.status, out.headers, out.body);
  };
}

function lowerHeaders(h: IncomingMessage["headers"]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

const MAX_BODY = 64 * 1024;

function readJson(req: IncomingMessage, maxBody = MAX_BODY): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c: Buffer | string) => {
      if (raw.length < maxBody) raw += c.toString().slice(0, maxBody - raw.length);
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

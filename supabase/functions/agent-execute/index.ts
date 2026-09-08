/**
 * Supabase Edge Function: agent-execute
 *
 * The production execution gateway. Runs the same core as the Vite dev middleware
 * (src/gateway/core.ts) — this file is only the Deno/HTTP wrapper.
 *
 * Secrets (set with `supabase secrets set …`, never in the repo):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (injected automatically by Supabase)
 *   OPENAI_API_KEY, OPENAI_MODEL              (first live provider)
 *   ANTHROPIC_API_KEY, GEMINI_API_KEY         (reported as not-configured until their adapters land)
 *   CTOS_ALLOW_STUB_PROVIDERS                 (dev only: "1" lets unconfigured providers answer with stubs)
 */
import { createClient } from "@supabase/supabase-js";
import { createServerRegistry } from "@/ai/registry";
import { ModelRouter } from "@/ai/router";
import { handleGatewayHttp } from "@/gateway/http";
import type { GatewayDeps } from "@/gateway/core";
import { SupabaseGatewayAuth, SupabaseGatewayStore, supabaseAuthApi, supabaseDb, type SupabaseServiceClientLike } from "@/gateway/supabase";

const env = Deno.env.toObject();
const url = env.SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

let deps: GatewayDeps | null = null;
function getDeps(): GatewayDeps {
  if (deps) return deps;
  if (!url || !serviceKey) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not available to the function");
  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as SupabaseServiceClientLike;
  const db = supabaseDb(client);
  deps = {
    auth: new SupabaseGatewayAuth(supabaseAuthApi(client), db),
    store: new SupabaseGatewayStore(db),
    router: new ModelRouter({ registry: createServerRegistry(env) }),
    mode: "supabase",
    log: (e: Record<string, unknown>) => console.log(JSON.stringify(e)),
  };
  return deps;
}

Deno.serve(async (req: Request) => {
  const headers: Record<string, string | undefined> = {};
  req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  let body: unknown = null;
  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch {
      body = null;
    }
  }
  try {
    const out = await handleGatewayHttp({ method: req.method, path: new URL(req.url).pathname, headers, body }, getDeps());
    return new Response(out.body === null ? null : JSON.stringify(out.body), { status: out.status, headers: out.headers });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, code: "internal", message: err instanceof Error ? err.message : String(err), status: 500 }), { status: 500, headers: { "content-type": "application/json" } });
  }
});

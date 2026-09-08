/**
 * Runtime-neutral HTTP surface for the gateway. Adapted to Deno (Edge Function) and Node (Vite dev
 * middleware) by tiny wrappers; the routing, auth extraction and error mapping live here once.
 *
 *   GET  <base>/health   → provider connection states (auth required)
 *   POST <base>          → execute { jobId, artifactTitle? }
 */
import { handleExecute, handleHealth, type GatewayDeps } from "./core";

export interface GatewayHttpRequest {
  method: string;
  /** Path after the host, e.g. "/agent-execute/health". */
  path: string;
  headers: Record<string, string | undefined>;
  /** Parsed JSON body (POST) or null. */
  body: unknown;
}

export interface GatewayHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

export function bearerToken(headers: Record<string, string | undefined>): string | null {
  const raw = headers.authorization ?? headers.Authorization;
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

export async function handleGatewayHttp(req: GatewayHttpRequest, deps: GatewayDeps): Promise<GatewayHttpResponse> {
  const headers = { ...CORS, "content-type": "application/json" };
  if (req.method === "OPTIONS") return { status: 204, headers: CORS, body: null };
  const token = bearerToken(req.headers);
  const path = req.path.split("?")[0].replace(/\/+$/, "");
  if (req.method === "GET" && path.endsWith("/health")) {
    const res = await handleHealth({ token }, deps);
    return { status: res.ok ? 200 : res.status, headers, body: res };
  }
  if (req.method === "POST") {
    const body = (req.body ?? {}) as { jobId?: unknown; artifactTitle?: unknown };
    if (typeof body.jobId !== "string") return { status: 400, headers, body: { ok: false, code: "bad_request", message: "Body must be { jobId: string }", status: 400 } };
    const res = await handleExecute({ token, jobId: body.jobId, artifactTitle: typeof body.artifactTitle === "string" ? body.artifactTitle : undefined }, deps);
    return { status: res.status, headers, body: res };
  }
  return { status: 405, headers, body: { ok: false, code: "bad_request", message: "Method not allowed", status: 405 } };
}

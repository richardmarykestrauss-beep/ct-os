/**
 * Vercel production handler for POST /api/agent-execute.
 *
 * Imports the exact same gateway the Vite dev middleware serves at /agent-execute
 * (src/gateway/node.ts, a thin Node wrapper over src/gateway/core.ts + gateway/http.ts — the same
 * core the Supabase Edge Function runs). No execution logic is duplicated between local dev, the
 * Supabase Edge Function and this Vercel handler: permission enforcement, ModelRouter provider
 * policy/fallback, structured-output validation, runs/execution-log recording and audit
 * orchestration semantics are the one implementation, imported everywhere.
 *
 * GET /api/agent-execute/health is served by the sibling file api/agent-execute/health.ts (Vercel
 * routes on the exact file path; `handleGatewayHttp` only branches on method + a "/health" path
 * suffix, so both files can safely share this one handler unmodified).
 *
 * Node.js runtime required: provider adapters use Node `fetch`/`AbortSignal`, and the Supabase
 * server client used here is not Edge-compatible (see vercel.json).
 *
 * Secrets (Vercel project → Settings → Environment Variables, SERVER-ONLY — never VITE_-prefixed):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createNodeGatewayHandler } from "../src/gateway/node";

export const config = { runtime: "nodejs" };

let handlerPromise: ReturnType<typeof createNodeGatewayHandler> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  handlerPromise ??= createNodeGatewayHandler({ env: process.env });
  await handlerPromise(req, res);
}

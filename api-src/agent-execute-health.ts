/**
 * Vercel production handler for GET /api/agent-execute/health.
 *
 * Source for the deployed api/agent-execute/health.js — see scripts/bundle-vercel-functions.mjs
 * and agent-execute.ts's docstring for why this is pre-bundled.
 *
 * Delegates to the exact same handler as agent-execute.ts — `handleGatewayHttp` recognises this
 * as the health check purely from the request path ending in "/health", which Vercel already
 * gives it verbatim, so nothing here is duplicated or rewritten.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createNodeGatewayHandler } from "@/gateway/node";

export const config = { runtime: "nodejs" };

let handlerPromise: ReturnType<typeof createNodeGatewayHandler> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  handlerPromise ??= createNodeGatewayHandler({ env: process.env });
  await handlerPromise(req, res);
}

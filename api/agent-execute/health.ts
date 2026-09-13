/**
 * Vercel production handler for GET /api/agent-execute/health.
 *
 * Delegates to the exact same handler as ../agent-execute.ts (see that file's docstring) —
 * `handleGatewayHttp` recognises this as the health check purely from the request path ending in
 * "/health", which Vercel already gives it verbatim, so nothing here is duplicated or rewritten.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createNodeGatewayHandler } from "../../src/gateway/node.js";

export const config = { runtime: "nodejs" };

let handlerPromise: ReturnType<typeof createNodeGatewayHandler> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  handlerPromise ??= createNodeGatewayHandler({ env: process.env });
  await handlerPromise(req, res);
}

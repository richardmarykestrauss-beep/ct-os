/**
 * Vercel production handler for POST /api/site-capture.
 *
 * Imports the exact same capture core the Vite dev middleware serves at /site-capture
 * (src/gateway/site-capture.ts) — no capture logic is duplicated between local dev and
 * production. Node.js runtime required: DNS-rebinding protection uses `node:dns/promises`,
 * which an Edge runtime does not provide (see vercel.json).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { captureSite, MAX_PAGES } from "../src/gateway/site-capture";

export const config = { runtime: "nodejs" };

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c: Buffer | string) => { raw += c.toString(); });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "Method not allowed" }));
    return;
  }
  try {
    const body = (await readJson(req)) as Record<string, unknown> | null;
    const url = typeof body?.url === "string" ? body.url.trim() : null;
    if (!url) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "url is required" }));
      return;
    }
    const maxPages = Math.min(MAX_PAGES, Math.max(1, Number(body?.maxPages ?? MAX_PAGES) || MAX_PAGES));
    const result = await captureSite(url, maxPages);
    if (!result.ok && "blocked" in result && result.blocked) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * Vite dev middleware: serves POST /agent-execute (and GET /agent-execute/health) and
 * POST /site-capture during `npm run dev`, using the exact same handlers production uses.
 *
 *   - /agent-execute → src/gateway/node.ts (Supabase-backed, or the CTOS_LOCAL_NO_SUPABASE=1 local
 *     gateway). The Vercel handler (api/agent-execute.ts) imports the same module directly.
 *   - /site-capture  → src/gateway/site-capture.ts (SSRF-safe, bounded, returns page DIGESTS —
 *     never raw HTML to the browser or a model). The Vercel handler (api/site-capture.ts) imports
 *     the same module directly.
 *
 * Secrets come from the process environment and .env.local WITHOUT the VITE_ prefix, so Vite never
 * exposes them to the browser. This file deliberately imports nothing from `src/` at config time —
 * modules are loaded through Vite's SSR module loader on first request, so the handler logic that
 * runs here is identical to what runs on Vercel/Supabase, just resolved a different way.
 */
import { loadEnv, type Plugin, type ViteDevServer } from "vite";

export const GATEWAY_PATH = "/agent-execute";
export const SITE_CAPTURE_PATH = "/site-capture";

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function jsonOk(res: import("node:http").ServerResponse, body: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonErr(res: import("node:http").ServerResponse, status: number, reason: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, reason }));
}

export function ctosGatewayPlugin(): Plugin {
  return {
    name: "ctos-execution-gateway",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      const mode = server.config.mode;
      // Third argument "" loads ALL variables (not only VITE_*). They stay in this process.
      const fileEnv = loadEnv(mode, server.config.root, "");
      const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };
      type Handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>;
      let handlerPromise: Promise<Handler> | null = null;

      // -------------------------------------------------------------------
      // POST /site-capture — bounded, SSRF-safe public capture → page digests
      // -------------------------------------------------------------------
      server.middlewares.use(SITE_CAPTURE_PATH, async (req, res) => {
        if (req.method !== "POST") { jsonErr(res, 405, "Method not allowed"); return; }
        try {
          const body = await readBody(req) as Record<string, unknown>;
          const url = typeof body.url === "string" ? body.url.trim() : null;
          if (!url) { jsonErr(res, 400, "url is required"); return; }
          const capture = await server.ssrLoadModule("/src/gateway/site-capture.ts") as typeof import("./site-capture");
          const maxPages = Math.min(capture.MAX_PAGES, Math.max(1, Number(body.maxPages ?? capture.MAX_PAGES) || capture.MAX_PAGES));
          const result = await capture.captureSite(url, maxPages);
          if (!result.ok && "blocked" in result && result.blocked) { jsonErr(res, 403, result.reason); return; }
          jsonOk(res, result);
        } catch (err) {
          jsonErr(res, 500, err instanceof Error ? err.message : String(err));
        }
      });

      // -------------------------------------------------------------------
      // POST /agent-execute — the ONE execution gateway (Supabase or local)
      // -------------------------------------------------------------------
      server.middlewares.use(GATEWAY_PATH, async (req, res) => {
        handlerPromise ??= server.ssrLoadModule("/src/gateway/node.ts").then((m) => {
          const mod = m as typeof import("./node");
          return mod.localGatewayEnabled(env) ? mod.createLocalGatewayHandler({ env }) : mod.createNodeGatewayHandler({ env });
        });
        try {
          const handler = await handlerPromise;
          // Restore the mount-stripped path so routing sees "/agent-execute/health".
          req.url = `${GATEWAY_PATH}${req.url === "/" ? "" : (req.url ?? "")}`;
          await handler(req, res);
        } catch (err) {
          handlerPromise = null;
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, code: "internal", message: err instanceof Error ? err.message : String(err), status: 500 }));
        }
      });
    },
  };
}

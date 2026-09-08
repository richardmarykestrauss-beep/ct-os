/**
 * Vite dev middleware: serves POST /agent-execute (and GET /agent-execute/health) during `npm run dev`
 * with the same gateway core the Supabase Edge Function runs.
 *
 * Secrets come from the process environment and .env.local WITHOUT the VITE_ prefix, so Vite never
 * exposes them to the browser. This file deliberately imports nothing from `src/` at config time —
 * the gateway is loaded through Vite's SSR module loader on first request.
 */
import { loadEnv, type Plugin, type ViteDevServer } from "vite";

export const GATEWAY_PATH = "/agent-execute";

export function ctosGatewayPlugin(): Plugin {
  return {
    name: "ctos-execution-gateway",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      const mode = server.config.mode;
      // Third argument "" loads ALL variables (not only VITE_*). They stay in this process.
      const fileEnv = loadEnv(mode, server.config.root, "");
      const env: Record<string, string | undefined> = { ...fileEnv, ...process.env };
      let handlerPromise: Promise<(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>> | null = null;
      server.middlewares.use(GATEWAY_PATH, async (req, res) => {
        handlerPromise ??= server.ssrLoadModule("/src/gateway/node.ts").then((m) => (m as typeof import("./node")).createNodeGatewayHandler({ env }));
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

#!/usr/bin/env node
/**
 * CTOS-004 Part A/N — the local MCP bridge entrypoint.
 *
 * Run with `npm run mcp:build && npm run mcp:start` (see docs/MCP-BRIDGE.md for the full setup and
 * for exactly how an MCP client like ChatGPT/Claude Desktop should be pointed at this process).
 *
 * Local dev auth (Part E): there is no HTTP request here to carry a bearer token, so this process
 * reads ONE token from CTOS_MCP_TOKEN (server env / .env.local, never committed) at startup and
 * registers exactly one ExternalClient for it via `bootstrapLocalExternalClient` — a function that
 * deliberately bypasses the human-admin gate every other external-client mutation goes through,
 * because at process boot there is no CT-OS human session to gate it with. That single client's
 * identity is then used for the whole stdio session. A future hosted mode (Part O) would resolve a
 * client from a per-request bearer header via `verifyExternalToken` instead — the tool registry
 * (src/mcp/registry.ts) and every tool handler are already written against `McpToolContext.client`
 * and do not know or care which of the two ever supplied it.
 *
 * Backing store (local dev only, honestly documented): this project has no Supabase configured
 * anywhere in this environment (only GEMINI_API_KEY is set — see CTOS-003A/B). There is therefore
 * nothing durable for the MCP server to connect to; it starts from the same seed data the app's own
 * embedded/local-mode gateway uses (src/data/seed.ts) and keeps it only in this process's memory
 * for the life of the session. Every write tool call really mutates that in-memory OSData and is
 * really enforced by the real service functions — nothing about the write/permission/audit path is
 * a stub — but nothing persists once this process exits. See docs/MCP-BRIDGE.md "Limitations".
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ExternalClientType, ExternalPermissionCeiling } from "@/data/types";
import { seedData } from "@/data/seed";
import { OSDataGatewayStore } from "@/gateway/store";
import { createServerRegistry } from "@/ai/registry";
import { bootstrapLocalExternalClient, recordClientUse, recordExternalAccess } from "@/services/external-clients";
import { registerAllTools } from "./registry";
import type { McpToolContext } from "./types";

/** Loads KEY=VALUE lines from .env.local into process.env, without ever overwriting a variable
 *  that is already set (so a real deployment's own env always wins) and without ever logging a value. */
function loadDotEnvLocal(root: string): void {
  const p = path.join(root, ".env.local");
  if (!existsSync(p)) return;
  const raw = readFileSync(p, "utf-8");
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

const VALID_CLIENT_TYPES: ExternalClientType[] = ["chatgpt", "claude", "automation", "other"];
const VALID_CEILINGS: ExternalPermissionCeiling[] = ["READ_ONLY", "GREEN_WRITE"];

async function main() {
  const root = process.cwd();
  loadDotEnvLocal(root);

  const token = process.env.CTOS_MCP_TOKEN;
  if (!token || token.length < 16) {
    console.error("[ctos-mcp] CTOS_MCP_TOKEN is not set (or too short) in .env.local — refusing to start. See docs/MCP-BRIDGE.md ‘Local dev auth’.");
    process.exit(1);
    return;
  }

  const name = process.env.CTOS_MCP_CLIENT_NAME?.trim() || "chatgpt-local";
  const typeEnv = (process.env.CTOS_MCP_CLIENT_TYPE?.trim() as ExternalClientType | undefined) ?? "chatgpt";
  const type: ExternalClientType = VALID_CLIENT_TYPES.includes(typeEnv) ? typeEnv : "chatgpt";
  const ceilingEnv = (process.env.CTOS_MCP_CEILING?.trim() as ExternalPermissionCeiling | undefined) ?? "READ_ONLY";
  const permissionCeiling: ExternalPermissionCeiling = VALID_CEILINGS.includes(ceilingEnv) ? ceilingEnv : "READ_ONLY";

  const boot = bootstrapLocalExternalClient(seedData, { name, type, permissionCeiling, rawToken: token });
  const store = new OSDataGatewayStore(boot.data, {});
  const registry = createServerRegistry(process.env);

  const ctx: McpToolContext = {
    store,
    registry,
    client: boot.client,
    now: () => new Date().toISOString(),
    recordAccess: (tool, input) => {
      const logged = recordExternalAccess(store.data, { externalClientId: boot.client.id, externalClientName: boot.client.name, tool, ...input });
      store.data = recordClientUse(logged.data, boot.client.id);
    },
  };

  const server = new McpServer({ name: "ctos-mcp", version: "1.0.0" });
  registerAllTools(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only — stdout is the MCP JSON-RPC channel and must never carry anything else.
  console.error(`[ctos-mcp] CT-OS MCP bridge running (stdio). Client "${boot.client.name}" [${boot.client.type}, ${boot.client.permissionCeiling}]. Backing store: in-memory seed (no Supabase configured). No secret is ever printed, logged or returned by any tool.`);
}

main().catch((err) => {
  console.error("[ctos-mcp] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

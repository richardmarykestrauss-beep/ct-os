/**
 * CTOS-004 Part J — the single dispatch wrapper every MCP tool goes through.
 *
 * `registerAllTools` is the only place that turns a `McpToolDef` into a live MCP tool. For every
 * call, in this exact order:
 *   1. Parse input against the tool's Zod schema. Malformed input never reaches a handler.
 *   2. Check the calling client is ACTIVE and its permission ceiling / allow-list covers this tool
 *      (services/external-clients.ts#toolAllowed) — a READ_ONLY client is refused before a
 *      GREEN_WRITE tool's handler ever runs.
 *   3. Run the handler. A thrown error becomes a structured error result, never an unhandled crash.
 *   4. Record the call to externalAccessLog (Part D/L) — success, denial or error alike — and touch
 *      the client's lastUsedAt.
 * No tool handler does its own auth check or its own logging; this file is where every tool is
 * uniformly safe, so a new tool added to READ_TOOLS/WRITE_TOOLS automatically inherits all four
 * guarantees above.
 *
 * `def.schema` is validated in full via `safeParse` (step 1) — that is the real enforcement. The
 * `inputSchema` handed to the SDK's `registerTool` (derived from the same schema's `.shape`) only
 * drives MCP tool *discovery* (what an MCP client sees before calling); the two are intentionally
 * decoupled with an `any` cast at that one call site rather than fighting the SDK's generic
 * overloads for a heterogeneous, dynamically-built list of tools with different shapes.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toolAllowed } from "@/services/external-clients";
import type { McpToolContext, McpToolDef } from "./types";
import { READ_TOOLS } from "./tools/read";
import { contextProject } from "./tools/context";
import { dashboardSummary } from "./tools/dashboard";
import { WRITE_TOOLS } from "./tools/write";

export const ALL_TOOLS: McpToolDef<any>[] = [...READ_TOOLS, contextProject, dashboardSummary, ...WRITE_TOOLS];

function textResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export function registerAllTools(server: McpServer, ctx: McpToolContext): void {
  for (const def of ALL_TOOLS) {
    const shape = (def.schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
    const cb = async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
      const parsed = def.schema.safeParse(rawArgs);
      if (!parsed.success) {
        const reason = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        ctx.recordAccess(def.name, { requestedAction: `${def.name} (invalid input)`, result: "error", reason: `validation failed: ${reason}` });
        return textResult({ ok: false, error: "invalid input", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, true);
      }
      if (!toolAllowed(ctx.client, def.name, def.ceiling)) {
        ctx.recordAccess(def.name, { requestedAction: def.name, result: "denied", reason: `client status=${ctx.client.status} ceiling=${ctx.client.permissionCeiling} required=${def.ceiling}` });
        return textResult({ ok: false, error: "forbidden: this external client is not permitted to call this tool" }, true);
      }
      try {
        const outcome = await def.handler(ctx, parsed.data);
        ctx.recordAccess(def.name, {
          requestedAction: outcome.requestedAction,
          projectId: outcome.projectId ?? null,
          permissionTier: outcome.permissionTier ?? (def.ceiling === "READ_ONLY" ? "READ" : null),
          result: "allowed",
          createdIds: outcome.createdIds,
        });
        return textResult({ ok: true, data: outcome.result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.recordAccess(def.name, { requestedAction: def.name, result: "error", reason: message });
        return textResult({ ok: false, error: message }, true);
      }
    };
    (server.registerTool as unknown as (name: string, config: unknown, cb: unknown) => unknown)(def.name, { title: def.title, description: def.description, inputSchema: shape }, cb);
  }
}

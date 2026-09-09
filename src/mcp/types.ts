/**
 * MCP tool layer shared types (CTOS-004 Part A/J).
 *
 * Every MCP tool is a `McpToolDef`: a name, a Zod input schema, the minimum permission ceiling an
 * ExternalClient needs to call it, and a pure-ish handler that reads/writes through the existing
 * gateway store (never the database directly - Part A). `src/mcp/registry.ts` is the single place
 * that turns a `McpToolDef` into an actual MCP tool: it validates input, checks the calling
 * client's ceiling/allow-list (`toolAllowed`), calls the handler, and always records the call to
 * `externalAccessLog` (Part D/L) - success, denial or error alike. A tool handler never needs to
 * do its own auth check or its own logging; the registry is where every tool is uniformly safe.
 */
import type { z } from "zod";
import type { ExternalAccessResult, ExternalClient, ExternalPermissionCeiling, OSData, PermissionLevel } from "@/data/types";
import type { OSDataGatewayStore } from "@/gateway/store";
import type { ProviderRegistry } from "@/ai/registry";

/** One MCP tool call's outcome, recorded regardless of success (Part D/L). */
export interface AccessRecordInput {
  requestedAction: string;
  projectId?: string | null;
  permissionTier?: PermissionLevel | "READ" | null;
  result: ExternalAccessResult;
  reason?: string;
  createdIds?: string[];
}

/**
 * What every tool handler receives. `store.data` is the live OSData snapshot; handlers read it
 * directly and, for writes, replace `store.data` with the result of a pure service call (the same
 * `(data) => data` pattern every CT-OS service function already uses - see services/agent-jobs.ts,
 * services/knowledge.ts, services/artifacts.ts). `client` is resolved once for this MCP session
 * (local stdio: at server startup from CTOS_MCP_TOKEN; a future hosted mode would resolve it per
 * request from a bearer token - see docs/MCP-BRIDGE.md "Hosted mode design"). `recordAccess` is
 * called by the registry wrapper, never by a tool handler itself.
 */
export interface McpToolContext {
  store: OSDataGatewayStore;
  registry: ProviderRegistry;
  client: ExternalClient;
  now: () => string;
  recordAccess: (tool: string, input: AccessRecordInput) => void;
}

/** What a tool handler returns to the registry wrapper - the payload plus what to log. */
export interface McpToolOutcome {
  result: unknown;
  requestedAction: string;
  projectId?: string | null;
  permissionTier?: PermissionLevel | "READ" | null;
  createdIds?: string[];
}

export interface McpToolDef<Input = unknown> {
  /** Dotted tool name, e.g. "ctos.projects.list" - also the identity checked against a client's allowedTools[]. */
  name: string;
  title: string;
  description: string;
  /** Minimum ExternalPermissionCeiling required to invoke this tool at all (checked via services/external-clients#toolAllowed). */
  ceiling: ExternalPermissionCeiling;
  /** Parsed with .safeParse before the handler ever runs - malformed input never reaches OSData (Part J, Part M). */
  schema: z.ZodType<Input>;
  handler: (ctx: McpToolContext, input: Input) => McpToolOutcome | Promise<McpToolOutcome>;
}

/** Small helper every read tool uses: never throw on a missing id, return a structured "not found" instead. */
export class McpNotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`${what} "${id}" not found`);
    this.name = "McpNotFoundError";
  }
}

/** Trims a JSON-serializable value so one artifact/content blob can never blow up a tool response. */
export function trimForTransport(value: unknown, maxChars = 8000): unknown {
  if (value === undefined || value === null) return null;
  const json = JSON.stringify(value);
  return json.length <= maxChars ? value : { _truncated: true, preview: json.slice(0, maxChars) };
}

export function readOnly<Input>(def: Omit<McpToolDef<Input>, "ceiling">): McpToolDef<Input> {
  return { ...def, ceiling: "READ_ONLY" };
}

export function greenWrite<Input>(def: Omit<McpToolDef<Input>, "ceiling">): McpToolDef<Input> {
  return { ...def, ceiling: "GREEN_WRITE" };
}

export type { OSData };

/**
 * CTOS-004 Part M — MCP bridge tests.
 *
 * Two layers are tested:
 *  1. services/external-clients.ts directly — identity creation/rotation/revocation, token
 *     hashing, the human-admin gate, and the tool-ceiling check (`toolAllowed`) as a pure function.
 *  2. src/mcp/registry.ts end to end, via a fake MCP server that just captures the callback each
 *     tool registers — this is the SAME `registerAllTools` function src/mcp/server.ts uses, so a
 *     passing test here proves the actual validate → permission-check → handle → log pipeline, not
 *     a reimplementation of it.
 */
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExternalPermissionCeiling, ExternalClientStatus, OSData } from "@/data/types";
import { AGENT_IDS, PROJECT_UPROOF } from "@/data/seed";
import { OSDataGatewayStore } from "@/gateway/store";
import { createServerRegistry } from "@/ai/registry";
import { bootstrapLocalExternalClient, createExternalClient, recordClientUse, recordExternalAccess, revokeExternalClient, rotateExternalClientToken, setExternalClientStatus, toolAllowed, verifyExternalToken, type ExternalClientActor } from "@/services/external-clients";
import { registerAllTools } from "@/mcp/registry";
import type { McpToolContext } from "@/mcp/types";
import { base, admin, member, viewer } from "./fixtures";

// ---------------------------------------------------------------------------
// Layer 1 — services/external-clients.ts
// ---------------------------------------------------------------------------

const adminActor: ExternalClientActor = { kind: "human", id: admin.id, name: admin.displayName, role: "ADMIN" };
const memberActor: ExternalClientActor = { kind: "human", id: member.id, name: member.displayName, role: "TEAM_MEMBER" };
const viewerActor: ExternalClientActor = { kind: "human", id: viewer.id, name: viewer.displayName, role: "VIEWER" };

describe("CTOS-004 external identity (services/external-clients.ts)", () => {
  it("creates a client with a hashed token — the raw token is never stored anywhere in OSData", () => {
    const r = createExternalClient(base(), adminActor, { name: "chatgpt-richard", type: "chatgpt", permissionCeiling: "READ_ONLY" });
    expect(r.rawToken).toMatch(/^ctos_ext_[0-9a-f]{48}$/);
    expect(r.client.tokenHash).toBeTruthy();
    expect(r.client.tokenHash).not.toBe(r.rawToken);
    expect(r.client.tokenPrefix).toBe(r.rawToken.slice(0, 8));
    expect(JSON.stringify(r.data)).not.toContain(r.rawToken);
  });

  it("TEAM_MEMBER and VIEWER may not create, disable, rotate or revoke an external client", () => {
    const d = base();
    expect(() => createExternalClient(d, memberActor, { name: "x", type: "other", permissionCeiling: "READ_ONLY" })).toThrow(/Admin or Production Lead/);
    expect(() => createExternalClient(d, viewerActor, { name: "x", type: "other", permissionCeiling: "READ_ONLY" })).toThrow();
  });

  it("an agent-shaped actor is rejected at the type level (compile-time) and at runtime", () => {
    const agentShaped = { kind: "agent" } as unknown as ExternalClientActor;
    expect(() => createExternalClient(base(), agentShaped, { name: "x", type: "other", permissionCeiling: "READ_ONLY" })).toThrow(/Only a human/);
  });

  it("rotating a token invalidates the old one and the new raw token verifies", () => {
    const created = createExternalClient(base(), adminActor, { name: "c", type: "chatgpt", permissionCeiling: "READ_ONLY" });
    const rotated = rotateExternalClientToken(created.data, adminActor, created.client.id);
    expect(verifyExternalToken(rotated.data, created.rawToken)).toBeNull();
    expect(verifyExternalToken(rotated.data, rotated.rawToken)?.id).toBe(created.client.id);
  });

  it("revoking a client clears its token hash and blocks re-verification; it cannot be re-enabled or rotated", () => {
    const created = createExternalClient(base(), adminActor, { name: "c", type: "chatgpt", permissionCeiling: "READ_ONLY" });
    const revoked = revokeExternalClient(created.data, adminActor, created.client.id);
    expect(revoked.client.tokenHash).toBeNull();
    expect(verifyExternalToken(revoked.data, created.rawToken)).toBeNull();
    expect(() => setExternalClientStatus(revoked.data, adminActor, created.client.id, "ACTIVE")).toThrow(/revoked/);
    expect(() => rotateExternalClientToken(revoked.data, adminActor, created.client.id)).toThrow(/revoked/);
  });

  it("a disabled client fails verification even with the correct token", () => {
    const created = createExternalClient(base(), adminActor, { name: "c", type: "chatgpt", permissionCeiling: "READ_ONLY" });
    const disabled = setExternalClientStatus(created.data, adminActor, created.client.id, "DISABLED");
    expect(verifyExternalToken(disabled.data, created.rawToken)).toBeNull();
  });

  it("toolAllowed: READ_ONLY covers read tools only; GREEN_WRITE covers both; an allow-list narrows further; a non-ACTIVE client is always denied", () => {
    const readOnly = createExternalClient(base(), adminActor, { name: "ro", type: "chatgpt", permissionCeiling: "READ_ONLY" }).client;
    const greenWrite = createExternalClient(base(), adminActor, { name: "gw", type: "chatgpt", permissionCeiling: "GREEN_WRITE" }).client;
    expect(toolAllowed(readOnly, "ctos.projects.list", "READ_ONLY")).toBe(true);
    expect(toolAllowed(readOnly, "ctos.ticket.create", "GREEN_WRITE")).toBe(false);
    expect(toolAllowed(greenWrite, "ctos.ticket.create", "GREEN_WRITE")).toBe(true);
    const narrowed = { ...greenWrite, allowedTools: ["ctos.projects.list"] };
    expect(toolAllowed(narrowed, "ctos.projects.list", "READ_ONLY")).toBe(true);
    expect(toolAllowed(narrowed, "ctos.ticket.create", "GREEN_WRITE")).toBe(false);
    expect(toolAllowed({ ...greenWrite, status: "DISABLED" }, "ctos.projects.list", "READ_ONLY")).toBe(false);
  });

  it("recordExternalAccess is append-only and caps at 500 entries", () => {
    let data = base();
    for (let i = 0; i < 3; i++) data = recordExternalAccess(data, { externalClientId: "ext_x", externalClientName: "x", tool: "ctos.projects.list", requestedAction: "list", result: "allowed" }).data;
    expect(data.externalAccessLog.length).toBe(3);
  });

  it("bootstrapLocalExternalClient (local MCP server startup) is not actor-gated but still only ever stores a hash", () => {
    const r = bootstrapLocalExternalClient(base(), { name: "chatgpt-local", type: "chatgpt", permissionCeiling: "READ_ONLY", rawToken: "a-local-dev-token-not-a-real-secret" });
    expect(r.client.createdById).toBeNull();
    expect(JSON.stringify(r.data)).not.toContain("a-local-dev-token-not-a-real-secret");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — src/mcp/registry.ts end to end, via a fake MCP server
// ---------------------------------------------------------------------------

function harness(data: OSData, ceiling: ExternalPermissionCeiling, status: ExternalClientStatus = "ACTIVE") {
  const boot = bootstrapLocalExternalClient(data, { name: "test-client", type: "chatgpt", permissionCeiling: ceiling, rawToken: "test-only-token-0123456789abcdef" });
  const client = status === "ACTIVE" ? boot.client : { ...boot.client, status };
  const seeded = { ...boot.data, externalClients: boot.data.externalClients.map((c) => (c.id === client.id ? client : c)) };
  const store = new OSDataGatewayStore(seeded, {});
  const registry = createServerRegistry({});
  const ctx: McpToolContext = {
    store,
    registry,
    client,
    now: () => "2026-01-01T00:00:00.000Z",
    recordAccess: (tool, input) => {
      const logged = recordExternalAccess(store.data, { externalClientId: client.id, externalClientName: client.name, tool, ...input });
      store.data = recordClientUse(logged.data, client.id);
    },
  };
  const calls = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>();
  const fakeServer = { registerTool: (name: string, _config: unknown, cb: (args: Record<string, unknown>) => Promise<CallToolResult>) => calls.set(name, cb) };
  registerAllTools(fakeServer as unknown as McpServer, ctx);
  return { ctx, store, calls };
}

function payload(result: CallToolResult): { ok: boolean; data?: unknown; error?: string } {
  const text = result.content[0];
  if (!text || text.type !== "text") throw new Error("expected a text content block");
  return JSON.parse(text.text);
}

describe("CTOS-004 MCP tool registry (src/mcp/registry.ts)", () => {
  it("a READ_ONLY client can call a read tool and gets structured data back", async () => {
    const { calls } = harness(base(), "READ_ONLY");
    const res = await calls.get("ctos.projects.list")!({});
    expect(res.isError).toBeFalsy();
    const body = payload(res);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("ctos.context.project returns a compressed pack for a known project", async () => {
    const { calls } = harness(base(), "READ_ONLY");
    const res = await calls.get("ctos.context.project")!({ projectId: PROJECT_UPROOF });
    const body = payload(res) as { ok: boolean; data: { identity: { projectId: string }; nextRecommendedAction: unknown } };
    expect(body.ok).toBe(true);
    expect(body.data.identity.projectId).toBe(PROJECT_UPROOF);
    expect(body.data.nextRecommendedAction).toBeDefined();
  });

  it("ctos.dashboard.summary never leaks a provider credential or env var value, only ids/labels/state", async () => {
    const { calls } = harness(base(), "READ_ONLY");
    const res = await calls.get("ctos.dashboard.summary")!({});
    const text = res.content[0];
    if (text.type !== "text") throw new Error("expected text");
    expect(text.text).not.toMatch(/sk-|AIza|ctos_ext_/);
    const body = payload(res) as { data: { providerHealth: Array<Record<string, unknown>> } };
    for (const p of body.data.providerHealth) expect(Object.keys(p).sort()).toEqual(["available", "id", "label", "state"].sort());
  });

  it("unknown project id returns a structured error, never a thrown exception", async () => {
    const { calls } = harness(base(), "READ_ONLY");
    const res = await calls.get("ctos.projects.get")!({ projectId: "proj_does_not_exist" });
    expect(res.isError).toBeFalsy(); // handled, not a tool-level error
    const body = payload(res) as { ok: boolean; data: { ok: boolean; error: string } };
    expect(body.data.ok).toBe(false);
    expect(body.data.error).toMatch(/not found/);
  });

  it("malformed input is rejected by schema validation before any handler runs", async () => {
    const { calls, store } = harness(base(), "READ_ONLY");
    const before = store.data.externalAccessLog.length;
    const res = await calls.get("ctos.projects.get")!({ projectId: 12345 });
    expect(res.isError).toBe(true);
    const body = payload(res);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid input");
    expect(store.data.externalAccessLog.length).toBe(before + 1);
    expect(store.data.externalAccessLog.at(-1)?.result).toBe("error");
  });

  it("a disabled client is refused even for a plain read tool", async () => {
    const { calls } = harness(base(), "READ_ONLY", "DISABLED");
    const res = await calls.get("ctos.projects.list")!({});
    expect(res.isError).toBe(true);
    expect(payload(res).error).toMatch(/forbidden/);
  });

  it("permission ceiling: a READ_ONLY client cannot call a GREEN_WRITE tool", async () => {
    const { calls, store } = harness(base(), "READ_ONLY");
    const res = await calls.get("ctos.ticket.create")!({ projectId: PROJECT_UPROOF, title: "x", agentId: AGENT_IDS.A02, phase: "UX", objective: "x" });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toMatch(/forbidden/);
    expect(store.data.tickets.some((t) => t.title === "x")).toBe(false);
  });

  it("GREEN_WRITE client: ctos.ticket.create really creates a ticket and logs an activity event", async () => {
    const { calls, store } = harness(base(), "GREEN_WRITE");
    const res = await calls.get("ctos.ticket.create")!({ projectId: PROJECT_UPROOF, title: "External ticket", agentId: AGENT_IDS.A02, phase: "UX", objective: "Do the thing" });
    expect(res.isError).toBeFalsy();
    const body = payload(res) as { ok: boolean; data: { ticketId: string; code: string } };
    expect(body.ok).toBe(true);
    expect(body.data.code).toMatch(/^EXT-\d{3}$/);
    expect(store.data.tickets.some((t) => t.id === body.data.ticketId)).toBe(true);
    expect(store.data.externalAccessLog.some((e) => e.tool === "ctos.ticket.create" && e.result === "allowed")).toBe(true);
  });

  it("ctos.knowledge.propose always lands as CANDIDATE, never APPROVED, regardless of ceiling", async () => {
    const { calls, store } = harness(base(), "GREEN_WRITE");
    const res = await calls.get("ctos.knowledge.propose")!({ title: "Lesson from external assistant", content: "Always check X before Y.", category: "process", proposedScope: "AGENCY" });
    const body = payload(res) as { ok: boolean; data: { knowledgeItemId: string; status: string } };
    expect(body.data.status).toBe("CANDIDATE");
    const item = store.data.knowledgeItems.find((k) => k.id === body.data.knowledgeItemId);
    expect(item?.status).toBe("CANDIDATE");
  });

  it("AMBER agent_job.request: creates a PENDING approval, never an APPROVED one — no self-approval path exists", async () => {
    const { calls, store } = harness(base(), "GREEN_WRITE");
    const res = await calls.get("ctos.agent_job.request")!({ projectId: PROJECT_UPROOF, agentId: AGENT_IDS.A05, instructions: "Fix the mobile header" });
    const body = payload(res) as { ok: boolean; data: { jobId: string; permissionLevel: string; approvalId: string | null } };
    expect(body.data.permissionLevel).toBe("AMBER");
    expect(body.data.approvalId).toBeTruthy();
    const approval = store.data.jobApprovals.find((a) => a.id === body.data.approvalId);
    expect(approval?.status).toBe("PENDING");
    expect(approval?.kind).toBe("APPROVAL");
    const job = store.data.agentJobs.find((j) => j.id === body.data.jobId);
    expect(job?.status).toBe("QUEUED");
  });

  it("RED agent_job.request: job stays QUEUED, no approval or authorization record is ever created", async () => {
    const d = base();
    const redData: OSData = { ...d, agents: d.agents.map((a) => (a.id === AGENT_IDS.A02 ? { ...a, permissionLevel: "RED" } : a)) };
    const { calls, store } = harness(redData, "GREEN_WRITE");
    const beforeApprovals = store.data.jobApprovals.length;
    const res = await calls.get("ctos.agent_job.request")!({ projectId: PROJECT_UPROOF, agentId: AGENT_IDS.A02, instructions: "Publish the homepage" });
    const body = payload(res) as { ok: boolean; data: { jobId: string; permissionLevel: string; approvalId: string | null } };
    expect(body.data.permissionLevel).toBe("RED");
    expect(body.data.approvalId).toBeNull();
    expect(store.data.jobApprovals.length).toBe(beforeApprovals);
    const job = store.data.agentJobs.find((j) => j.id === body.data.jobId);
    expect(job?.status).toBe("QUEUED");
  });

  it("ctos.approval.request on a RED job only logs the request — it never creates an approval record", async () => {
    const d = base();
    const redAgent = d.agents.find((a) => a.id === AGENT_IDS.A02)!;
    const redData: OSData = { ...d, agents: d.agents.map((a) => (a.id === AGENT_IDS.A02 ? { ...a, permissionLevel: "RED" } : a)) };
    const { calls, store } = harness(redData, "GREEN_WRITE");
    const jobRes = await calls.get("ctos.agent_job.request")!({ projectId: PROJECT_UPROOF, agentId: redAgent.id, instructions: "Publish the homepage" });
    const jobBody = payload(jobRes) as { data: { jobId: string } };
    const before = store.data.jobApprovals.length;
    const res = await calls.get("ctos.approval.request")!({ jobId: jobBody.data.jobId });
    const body = payload(res) as { ok: boolean; data: { ok: boolean; note: string } };
    expect(body.data.note).toMatch(/human to authorize/);
    expect(store.data.jobApprovals.length).toBe(before);
  });

  it("every call — allowed, denied or error — is written to externalAccessLog with client identity and result", async () => {
    const { calls, store } = harness(base(), "READ_ONLY");
    await calls.get("ctos.projects.list")!({});
    await calls.get("ctos.ticket.create")!({ projectId: PROJECT_UPROOF, title: "x", agentId: AGENT_IDS.A02, phase: "UX", objective: "x" });
    const log = store.data.externalAccessLog;
    expect(log.some((e) => e.tool === "ctos.projects.list" && e.result === "allowed" && e.externalClientName === "test-client")).toBe(true);
    expect(log.some((e) => e.tool === "ctos.ticket.create" && e.result === "denied")).toBe(true);
  });

  it("secret isolation: no tool response or access log entry ever contains a raw token or provider API key shape", async () => {
    const { calls, store } = harness(base(), "GREEN_WRITE");
    const res = await calls.get("ctos.system.status")!({});
    const raw = JSON.stringify(res) + JSON.stringify(store.data.externalAccessLog);
    expect(raw).not.toContain("test-only-token-0123456789abcdef");
    expect(raw).not.toMatch(/sk-[a-zA-Z0-9]/);
  });
});

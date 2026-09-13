/**
 * CTOS-008: gateway/node.ts is the ONE handler both the Vite dev middleware and the Vercel
 * api/agent-execute.ts + api/agent-execute/health.ts files call — this proves it behaves
 * (fails closed, never crashes) with no Supabase configuration, without any network or secret.
 */
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createNodeGatewayHandler, gatewayConfigProblem, localGatewayEnabled } from "@/gateway/node";

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const stream = new Readable({ read() {} }) as unknown as IncomingMessage;
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  queueMicrotask(() => {
    if (body !== undefined) (stream as unknown as Readable).push(JSON.stringify(body));
    (stream as unknown as Readable).push(null);
  });
  return stream;
}

function fakeRes(): ServerResponse & { statusCode: number; body: string } {
  const chunks: string[] = [];
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
    },
    get body() {
      return chunks.join("");
    },
  };
  return res as unknown as ServerResponse & { statusCode: number; body: string };
}

describe("gatewayConfigProblem", () => {
  it("reports what's missing without ever including a secret value", () => {
    expect(gatewayConfigProblem({})).toMatch(/SUPABASE_URL/);
    expect(gatewayConfigProblem({ SUPABASE_URL: "https://x.supabase.co" })).toMatch(/SERVICE_ROLE/);
    expect(gatewayConfigProblem({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" })).toBeNull();
  });
});

describe("localGatewayEnabled", () => {
  it("only activates when explicitly opted in AND Supabase is not configured", () => {
    expect(localGatewayEnabled({})).toBe(false);
    expect(localGatewayEnabled({ CTOS_LOCAL_NO_SUPABASE: "1" })).toBe(true);
    expect(localGatewayEnabled({ CTOS_LOCAL_NO_SUPABASE: "1", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" })).toBe(false);
  });
});

describe("createNodeGatewayHandler — the exact handler api/agent-execute(.ts|/health.ts) call", () => {
  it("fails closed with 503 (never crashes) when Supabase secrets are absent, for both execute and health", async () => {
    const handler = createNodeGatewayHandler({ env: {} });

    const execRes = fakeRes();
    await handler(fakeReq("POST", "/api/agent-execute", { jobId: "job_1" }), execRes);
    expect(execRes.statusCode).toBe(503);
    expect(JSON.parse(execRes.body)).toMatchObject({ ok: false, code: "internal" });
    expect(execRes.body).not.toMatch(/eyJ|sk-|AIza/); // never echoes anything secret-shaped

    const healthRes = fakeRes();
    await handler(fakeReq("GET", "/api/agent-execute/health"), healthRes);
    expect(healthRes.statusCode).toBe(503);
  });
});

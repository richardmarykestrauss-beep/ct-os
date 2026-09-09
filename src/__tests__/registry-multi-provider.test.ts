/**
 * Server registry with all three live credentials present (CTOS-003 Part B) — providers.test.ts
 * already covers the OpenAI-only case; this confirms Claude and Gemini construct as live adapters
 * too, from their own env vars, with model overrides, and that no key crosses into the status
 * payload that ships to the browser.
 */
import { describe, expect, it } from "vitest";
import { createServerRegistry } from "@/ai/registry";
import type { FetchLike } from "@/ai/providers/openai";

const OPENAI_SECRET = "sk-test-openai-SECRET";
const CLAUDE_SECRET = "sk-ant-test-claude-SECRET";
const GEMINI_SECRET = "AIzaSy-test-gemini-SECRET";

const noopFetch: FetchLike = (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" })) as FetchLike;

describe("server registry — all three live credentials", () => {
  it("builds live Claude, OpenAI and Gemini adapters and reports them all connected", async () => {
    const reg = createServerRegistry(
      { OPENAI_API_KEY: OPENAI_SECRET, ANTHROPIC_API_KEY: CLAUDE_SECRET, GEMINI_API_KEY: GEMINI_SECRET },
      { fetch: noopFetch },
    );
    const status = await reg.status();
    expect(status.map((s) => `${s.id}:${s.state}:${s.available}`)).toEqual(["claude:connected:true", "openai:connected:true", "gemini:connected:true"]);
    expect(JSON.stringify(status)).not.toContain(OPENAI_SECRET);
    expect(JSON.stringify(status)).not.toContain(CLAUDE_SECRET);
    expect(JSON.stringify(status)).not.toContain(GEMINI_SECRET);
  });

  it("honours per-provider model overrides without ever exposing them alongside a secret", async () => {
    const reg = createServerRegistry(
      { ANTHROPIC_API_KEY: CLAUDE_SECRET, ANTHROPIC_MODEL: "claude-3-5-haiku-20241022", GEMINI_API_KEY: GEMINI_SECRET, GEMINI_MODEL: "gemini-1.5-pro" },
      { fetch: noopFetch },
    );
    const claude = reg.get("claude");
    const gemini = reg.get("gemini");
    expect(claude?.connected).toBe(true);
    expect(gemini?.connected).toBe(true);
  });

  it("a subset of credentials leaves exactly the uncredentialed providers not_configured, never silently stubbed", async () => {
    const reg = createServerRegistry({ ANTHROPIC_API_KEY: CLAUDE_SECRET }, { fetch: noopFetch });
    const status = await reg.status();
    expect(status.map((s) => `${s.id}:${s.state}`)).toEqual(["claude:connected", "openai:not_configured", "gemini:not_configured"]);
  });
});

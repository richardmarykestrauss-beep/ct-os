import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import {
  detectXmlLeakage,
  detectTruncation,
  extractJson,
  FakeTransport,
  callClaude,
} from "../claude-adapter";

// ---------------------------------------------------------------------------
// detectXmlLeakage
// ---------------------------------------------------------------------------

describe("detectXmlLeakage", () => {
  it("detects bare XML tags", () => {
    expect(detectXmlLeakage("<invoke>foo</invoke>")).toBe(true);
    expect(detectXmlLeakage("<function_calls>")).toBe(true);
  });

  it("detects HTML-encoded tags", () => {
    expect(detectXmlLeakage("&lt;tool&gt;")).toBe(true);
  });

  it("does not flag clean JSON", () => {
    expect(detectXmlLeakage('{"title":"hello","value":42}')).toBe(false);
  });

  it("does not flag empty string", () => {
    expect(detectXmlLeakage("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectTruncation
// ---------------------------------------------------------------------------

describe("detectTruncation", () => {
  it("flags unclosed JSON object", () => {
    expect(detectTruncation('{"title":"foo"')).toBe(true);
  });

  it("flags unclosed JSON array", () => {
    expect(detectTruncation('[{"id":1}')).toBe(true);
  });

  it("does not flag complete JSON", () => {
    expect(detectTruncation('{"title":"foo"}')).toBe(false);
  });

  it("flags prose ending mid-sentence", () => {
    expect(detectTruncation("Here is the content")).toBe(true);
  });

  it("does not flag empty string", () => {
    expect(detectTruncation("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------

describe("extractJson", () => {
  it("parses raw JSON", () => {
    expect(extractJson('{"x":1}')).toEqual({ x: 1 });
  });

  it("extracts JSON from markdown code fence", () => {
    const md = "```json\n{\"x\":1}\n```";
    expect(extractJson(md)).toEqual({ x: 1 });
  });

  it("extracts JSON embedded in prose", () => {
    const prose = 'Here is the result:\n{"x":1}\nEnd.';
    expect(extractJson(prose)).toEqual({ x: 1 });
  });

  it("returns null for non-JSON string", () => {
    expect(extractJson("This is just text.")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractJson("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FakeTransport
// ---------------------------------------------------------------------------

describe("FakeTransport", () => {
  it("returns scripted success responses in order", async () => {
    const ft = new FakeTransport([
      { kind: "success", response: { x: 1 } },
      { kind: "success", response: { x: 2 } },
    ]);
    const r1 = await ft.call("prompt1");
    expect(JSON.parse(r1.raw)).toEqual({ x: 1 });
    const r2 = await ft.call("prompt2");
    expect(JSON.parse(r2.raw)).toEqual({ x: 2 });
    expect(ft.calls).toBe(2);
  });

  it("throws scripted errors", async () => {
    const ft = new FakeTransport([
      { kind: "error", errorKind: "transport_error", message: "Network failure" },
    ]);
    await expect(ft.call("p")).rejects.toThrow("Network failure");
  });

  it("throws when queue is exhausted", async () => {
    const ft = new FakeTransport([]);
    await expect(ft.call("p")).rejects.toThrow(/no more entries/);
  });
});

// ---------------------------------------------------------------------------
// callClaude — success
// ---------------------------------------------------------------------------

const SimpleSchema = z.object({ value: z.number() });

describe("callClaude — success", () => {
  it("returns parsed value on first attempt", async () => {
    const ft = new FakeTransport([{ kind: "success", response: { value: 42 } }]);
    const result = await callClaude("prompt", { schema: SimpleSchema, transport: ft.call.bind(ft) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ value: 42 });
      expect(result.attempts).toBe(1);
    }
  });

  it("extracts JSON from prose response", async () => {
    const ft = new FakeTransport([{ kind: "success", response: 'Here you go: {"value": 7}' }]);
    const result = await callClaude("prompt", { schema: SimpleSchema, transport: ft.call.bind(ft) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// callClaude — XML leakage (no retry)
// ---------------------------------------------------------------------------

describe("callClaude — xml_leakage", () => {
  it("fails immediately on XML leakage without retry", async () => {
    const ft = new FakeTransport([
      { kind: "success", response: "<invoke>tool</invoke>" },
      { kind: "success", response: { value: 1 } }, // should NOT be reached
    ]);
    const result = await callClaude("prompt", { schema: SimpleSchema, transport: ft.call.bind(ft) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("xml_leakage");
      expect(result.attempts).toBe(1); // no retry
    }
    expect(ft.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// callClaude — schema validation failure with retry
// ---------------------------------------------------------------------------

describe("callClaude — schema_invalid with retry", () => {
  it("retries on schema mismatch and succeeds", async () => {
    const ft = new FakeTransport([
      { kind: "success", response: { wrong_field: 99 } },
      { kind: "success", response: { value: 5 } },
    ]);
    const result = await callClaude("prompt", { schema: SimpleSchema, transport: ft.call.bind(ft), maxAttempts: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value).toBe(5);
      expect(result.attempts).toBe(2);
    }
  });

  it("returns schema_invalid after maxAttempts", async () => {
    const ft = new FakeTransport([
      { kind: "success", response: { wrong: 1 } },
      { kind: "success", response: { wrong: 2 } },
      { kind: "success", response: { wrong: 3 } },
    ]);
    const result = await callClaude("prompt", { schema: SimpleSchema, transport: ft.call.bind(ft), maxAttempts: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_invalid");
      expect(result.attempts).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// callClaude — transport error
// ---------------------------------------------------------------------------

describe("callClaude — transport_error", () => {
  it("retries on transport error and succeeds", async () => {
    const ft = new FakeTransport([
      { kind: "error", errorKind: "transport_error", message: "timeout" },
      { kind: "success", response: { value: 10 } },
    ]);
    const result = await callClaude("prompt", { schema: SimpleSchema, transport: ft.call.bind(ft), maxAttempts: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(2);
  });

  it("returns max_retries_exceeded after all attempts fail", async () => {
    const ft = new FakeTransport([
      { kind: "error", errorKind: "transport_error", message: "err1" },
      { kind: "error", errorKind: "transport_error", message: "err2" },
    ]);
    const result = await callClaude("prompt", { schema: SimpleSchema, transport: ft.call.bind(ft), maxAttempts: 2 });
    expect(result.ok).toBe(false);
    expect(ft.calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// callClaude — malformed JSON
// ---------------------------------------------------------------------------

describe("callClaude — malformed_tool_call", () => {
  it("fails on completely non-JSON output without XML", async () => {
    const ft = new FakeTransport([
      { kind: "success", response: "Absolutely! Here is my analysis..." },
      { kind: "success", response: "Still not JSON." },
    ]);
    const result = await callClaude("prompt", { schema: SimpleSchema, transport: ft.call.bind(ft), maxAttempts: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("malformed_tool_call");
  });
});

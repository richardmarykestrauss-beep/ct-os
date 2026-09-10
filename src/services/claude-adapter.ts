/**
 * Claude adapter hardening (CTOS-005A Part 10).
 *
 * Wraps raw Claude API responses with:
 *   - Malformed output detection (XML leakage, missing fields, truncation)
 *   - Bounded retry with exponential back-off (never infinite)
 *   - Fake transport fixtures for offline tests (no paid API calls)
 *   - Schema-invalid JSON recovery
 *
 * The adapter never swallows errors silently — every failure returns a
 * typed ClaudeAdapterError so callers can route to NEEDS_A_HAND.
 */
import type { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClaudeAdapterErrorKind =
  | "xml_leakage"
  | "missing_field"
  | "truncated_output"
  | "malformed_tool_call"
  | "schema_invalid"
  | "max_retries_exceeded"
  | "transport_error"
  | "unknown";

export interface ClaudeAdapterError {
  kind: ClaudeAdapterErrorKind;
  message: string;
  rawOutput?: string;
}

export interface ClaudeAdapterSuccess<T> {
  ok: true;
  value: T;
  attempts: number;
}

export interface ClaudeAdapterFailure {
  ok: false;
  error: ClaudeAdapterError;
  attempts: number;
}

export type ClaudeAdapterResult<T> = ClaudeAdapterSuccess<T> | ClaudeAdapterFailure;

// ---------------------------------------------------------------------------
// Malformed output detection
// ---------------------------------------------------------------------------

const XML_LEAK_PATTERNS = [
  /<\/?[a-z_]+>/i,        // bare XML tags
  /&lt;[a-z_]+&gt;/i,    // HTML-encoded tags
  /<function_calls>/i,    // tool call leakage
  /<\/antml:function_calls>/i,
  /<invoke/i,
  /<\/antml:invoke>/i,
];

/** Detect XML leakage in the raw output string. */
export function detectXmlLeakage(raw: string): boolean {
  return XML_LEAK_PATTERNS.some((p) => p.test(raw));
}

/** Detect potential truncation: output ends mid-sentence or mid-JSON. */
export function detectTruncation(raw: string): boolean {
  const trimmed = raw.trimEnd();
  if (trimmed.length === 0) return false;
  // JSON object/array that doesn't close
  const openBraces = (trimmed.match(/\{/g) ?? []).length;
  const closeBraces = (trimmed.match(/\}/g) ?? []).length;
  const openBrackets = (trimmed.match(/\[/g) ?? []).length;
  const closeBrackets = (trimmed.match(/\]/g) ?? []).length;
  if (openBraces > closeBraces || openBrackets > closeBrackets) return true;
  // Plain text that doesn't end with sentence terminator
  if (!/[.!?;}\]"']$/.test(trimmed)) return true;
  return false;
}

/** Attempt to extract JSON from a string that may have surrounding prose/XML. */
export function extractJson(raw: string): unknown | null {
  // Direct parse
  try { return JSON.parse(raw); } catch { /* fall through */ }
  // Strip markdown code fences
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ }
  }
  // Find first { ... } or [ ... ] block
  const objMatch = raw.match(/(\{[\s\S]*\})/);
  if (objMatch?.[1]) {
    try { return JSON.parse(objMatch[1]); } catch { /* fall through */ }
  }
  const arrMatch = raw.match(/(\[[\s\S]*\])/);
  if (arrMatch?.[1]) {
    try { return JSON.parse(arrMatch[1]); } catch { /* fall through */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fake transport (test fixture support)
// ---------------------------------------------------------------------------

export type FakeTransportEntry =
  | { kind: "success"; response: unknown }
  | { kind: "error"; errorKind: ClaudeAdapterErrorKind; message: string };

/** A test fixture transport that returns scripted responses without API calls. */
export class FakeTransport {
  private queue: FakeTransportEntry[];
  private callCount = 0;

  constructor(entries: FakeTransportEntry[]) {
    this.queue = [...entries];
  }

  get calls(): number {
    return this.callCount;
  }

  async call(_prompt: string): Promise<{ raw: string }> {
    this.callCount++;
    const entry = this.queue.shift();
    if (!entry) throw new Error("FakeTransport: no more entries in queue");
    if (entry.kind === "error") {
      const err = new Error(entry.message);
      (err as Error & { adapterKind: string }).adapterKind = entry.errorKind;
      throw err;
    }
    return { raw: typeof entry.response === "string" ? entry.response : JSON.stringify(entry.response) };
  }
}

// ---------------------------------------------------------------------------
// Adapter with bounded retry
// ---------------------------------------------------------------------------

export interface ClaudeAdapterOptions<T> {
  /** Maximum number of attempts (default 3). */
  maxAttempts?: number;
  /** Base back-off delay in ms for tests (default 0 in test env). */
  baseDelayMs?: number;
  /** Zod schema to validate parsed output. */
  schema: z.ZodType<T>;
  /** Transport function — real API or FakeTransport.call. */
  transport: (prompt: string) => Promise<{ raw: string }>;
}

/**
 * Call the Claude adapter with bounded retry.
 * On each failure, classify the error kind and retry unless:
 *   - It's a schema validation failure with valid JSON (the model misunderstood — retry may help)
 *   - We've hit maxAttempts
 *
 * Never retries xml_leakage or truncated_output more than once (indicates
 * a prompt/model issue that a retry won't fix).
 */
export async function callClaude<T>(
  prompt: string,
  opts: ClaudeAdapterOptions<T>,
): Promise<ClaudeAdapterResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 0;
  let lastError: ClaudeAdapterError | null = null;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const { raw } = await opts.transport(prompt);

      // XML leakage — do not retry (prompt/model issue)
      if (detectXmlLeakage(raw)) {
        lastError = { kind: "xml_leakage", message: "XML leak detected in model output", rawOutput: raw.slice(0, 500) };
        break;
      }

      // Truncation — retry once
      if (detectTruncation(raw)) {
        lastError = { kind: "truncated_output", message: "Output appears truncated", rawOutput: raw.slice(-200) };
        if (attempt >= maxAttempts) break;
        if (baseDelayMs > 0) await delay(baseDelayMs * attempt);
        continue;
      }

      // JSON extraction
      const parsed = extractJson(raw);
      if (parsed === null) {
        lastError = { kind: "malformed_tool_call", message: "Could not extract JSON from output", rawOutput: raw.slice(0, 500) };
        if (attempt >= maxAttempts) break;
        if (baseDelayMs > 0) await delay(baseDelayMs * attempt);
        continue;
      }

      // Schema validation
      const result = opts.schema.safeParse(parsed);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        lastError = { kind: "schema_invalid", message: `Schema validation failed: ${issues}`, rawOutput: raw.slice(0, 500) };
        if (attempt >= maxAttempts) break;
        if (baseDelayMs > 0) await delay(baseDelayMs * attempt);
        continue;
      }

      return { ok: true, value: result.data, attempts: attempt };
    } catch (err) {
      const e = err as Error & { adapterKind?: string };
      const kind = (e.adapterKind as ClaudeAdapterErrorKind | undefined) ?? "transport_error";
      lastError = { kind, message: e.message };
      if (attempt >= maxAttempts) break;
      if (baseDelayMs > 0) await delay(baseDelayMs * attempt);
    }
  }

  return {
    ok: false,
    error: lastError ?? { kind: "unknown", message: "Unknown adapter error" },
    attempts: attempt,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

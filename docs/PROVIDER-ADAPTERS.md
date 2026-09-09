# Provider Adapters

Providers are interchangeable intelligence behind one interface. Nothing outside `src/ai/providers/*`
knows how any provider is called; nothing outside the execution gateway can hold a provider key.

## The interface

```ts
interface AIProvider {
  id: "claude" | "openai" | "gemini";
  displayName: string;
  capabilities: ProviderCapability[];        // text, structured_output, long_context, vision, code,
                                              // review, reasoning, fast_generation, creative_generation
  connected: boolean;                        // live adapter with a credential present
  connectionState: "connected" | "not_configured" | "unavailable" | "rate_limited" | "degraded" | "disabled" | "stub";
  availability(): ProviderAvailability;      // { available: true } | { available: false, reason }
  execute(request: ProviderRequest): Promise<ProviderResponse>;
}
```

`ProviderRequest` = the neutral `ExecutionRequest` + `systemContext` (assembled sections) +
`outputJsonSchema` (JSON Schema for the required output, for providers that accept one).
`ProviderResponse` = `{ providerId, model, output, summary, usage, finishReason }`. Anything else a
provider returns stays inside the adapter.

## Adapters

| Provider | File | State | Env var (server-side) |
|---|---|---|---|
| OpenAI | `src/ai/providers/openai.ts` | **live** — Chat Completions with `response_format: json_schema` | `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4o-mini`) |
| Claude | `src/ai/providers/claude.ts` | **live** — Messages API with forced tool-use for structured output | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-3-5-sonnet-20241022`) |
| Gemini | `src/ai/providers/gemini.ts` | **live** — `generateContent` REST API | `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3.6-flash`, CTOS-004A reliability baseline; `gemini-3.8-flash` also supported) |
| Stub | `src/ai/providers/stub.ts` | deterministic; returns the schema example | — |

As of CTOS-003 all three are real, server-side-only adapters implementing `AIProvider` identically in
shape (same `ProviderError` categories, same `AbortController` timeout pattern, same key-redaction
discipline) so the router never needs to know which one it is talking to. A provider without its
credential present simply reports itself `not_configured` via `availability()`/`connectionState` — the
same code path a live provider that later loses its credential would report — rather than crashing.
**No live external call has been made in this sandboxed environment** — none of the three env vars are
set here; each adapter's request/response mapping is unit-tested against a fake `fetch` transport
(`src/__tests__/providers.test.ts`, `providers-claude.test.ts`, `providers-gemini.test.ts`), and
`src/__tests__/live-continuity-h.test.ts` exercises the real `ClaudeProvider`/`OpenAIProvider` classes
end to end (only their transport substituted) — see its own header comment for the exact honesty
framing.

### OpenAI adapter behaviour

* Builds `system` (agent identity + permission + scoped knowledge sections) and `user` (task, input
  artifacts, tools, output contract) messages from the neutral request.
* Sends `response_format: { type: "json_schema", json_schema: { name, schema, strict: false } }` derived
  from the Zod schema; CT-OS still validates the reply itself.
* Normalises: `model`, `usage.prompt_tokens/completion_tokens`, `finish_reason: length → truncated`,
  refusals (`choices[0].message.refusal`) → `finishReason: "refused"` (never an artifact), non-JSON
  content → `{ _unparsed }` so validation fails with an actionable message.
* Error mapping: 401/403 → `config` (not retryable); 429/5xx → `provider_unavailable`; other → `provider_error`;
  transport errors → `provider_unavailable`. The key is redacted from any error text.
* Timeout 120 s via `AbortController`.

### Claude adapter behaviour

* Auth: `x-api-key` header plus `anthropic-version: 2023-06-01`. POSTs to
  `https://api.anthropic.com/v1/messages`.
* Structured output: Anthropic's Messages API has no OpenAI-style `response_format`, so CT-OS forces
  the model into a single tool call whose `input_schema` is the job's required output JSON Schema —
  a tool named `emit_ctos_output`, sent with `tool_choice: { type: "tool", name: "emit_ctos_output" }`.
  The "tool call" is purely a structured-output mechanism; CT-OS never executes anything because of
  it, and the mechanism never crosses out of this file — callers only ever see `ProviderResponse`.
  When no output schema is present it falls back to asking for a bare JSON object in the response
  text.
* Normalises: `model`, `usage.input_tokens/output_tokens`, `stop_reason: "max_tokens" → truncated`,
  `stop_reason: "refusal"` → `finishReason: "refused"` (Anthropic's safety-triggered stop with no
  content), non-JSON/no-tool-use content → `{ _unparsed }`.
* Error mapping: identical scheme to OpenAI — 401/403 → `config`; 429/5xx → `provider_unavailable`;
  other → `provider_error`; transport errors → `provider_unavailable`. Key redacted from error text.
* Timeout 120 s via `AbortController`; `max_tokens` defaults to 4096 (configurable).

### Gemini adapter behaviour

* Auth: the key is sent as the **`x-goog-api-key` header**, never a `?key=` query parameter — Gemini's
  REST API supports both, but a header never ends up in a URL, browser history, a proxy access log, or
  a test/log's captured `call.url`, which the query-param form would risk. POSTs to
  `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`.
* Structured output: `generationConfig.responseMimeType: "application/json"`. CT-OS still validates
  every response the way it validates every provider's.
* Normalises: `modelVersion`, `usageMetadata.promptTokenCount/candidatesTokenCount`,
  `finishReason: "MAX_TOKENS" → truncated`. A prompt-level block (`promptFeedback.blockReason`) or a
  candidate `finishReason` in `{SAFETY, RECITATION, PROHIBITED_CONTENT, BLOCKLIST, SPII, OTHER}` both
  map to `finishReason: "refused"`. Non-JSON content → `{ _unparsed }`.
* Error mapping: identical scheme to OpenAI/Claude — 401/403 → `config`; 429/5xx →
  `provider_unavailable`; other → `provider_error`; transport errors → `provider_unavailable`. Key
  redacted from error text.
* Timeout 120 s via `AbortController`.
* **Reliability baseline (CTOS-004A):** `GEMINI_DEFAULT_MODEL` is `gemini-3.6-flash` — the model a
  genuine end-to-end execution was actually verified against (CTOS-003). `gemini-3.8-flash` remains
  fully supported via `GEMINI_MODEL` for a deliberately-chosen higher-tier run, but is not the
  unconfigured default. Either way, a 503 or other transient failure is never retried against the
  same model/provider in place: `HealthTracker.recordFailure` records it (5xx → `degraded`, 429 →
  `rate_limited`) and `ModelRouter.execute()` (`src/ai/router.ts`) moves straight to the next
  provider in the job's ranked fallback sequence within that same execution — see "Router and
  fallback" below.

### Adding a fourth provider

Implement `AIProvider` in a new file under `src/ai/providers/`, read the key in
`createServerRegistry`, keep the capability list honest, and return `ProviderResponse`. No other file
changes: routing, ranking, validation, fallback, logging, UI and tests already treat every provider
the same way.

## Shared health tracking (`HealthTracker`)

All three live adapters own one `HealthTracker` (`src/ai/providers/health.ts`). It never holds a
credential or any request/response content — only the category and HTTP status of the adapter's most
recent failure, and when it happened (a 60 s cooldown window by default), so `connectionState` can
report a provider that is currently failing instead of a flat "connected" that hides the problem:

```
recordFailure(category, httpStatus) → lastFailure = { category, httpStatus, at }
recordSuccess()                     → lastFailure = null
state(): "rate_limited" | "degraded" | "unavailable" | null   (null = nothing recent is wrong)
blocksAvailability(): boolean       (true for rate_limited and unavailable; a 5xx "degraded" blip
                                      does not block — the router may still try that provider)
```

* HTTP 429 → `rate_limited`.
* Failure category `"config"` (401/403 — a credential present but rejected) → `unavailable`.
* Failure category `"provider_unavailable"` (5xx / network, non-429) → `degraded`.

`connected` / `not_configured` / `disabled` are each adapter's own credential-and-policy decision
(never derived from `HealthTracker`); the tracker only ever supplies the three failure-derived states.

## `ProviderConnectionState` — the full seven states

```ts
type ProviderConnectionState =
  | "connected"      // credential present, adapter believes it's usable
  | "not_configured" // no credential in this environment
  | "unavailable"    // credential present but the provider currently refuses it (401/403)
  | "rate_limited"   // last call got HTTP 429; still connected, temporarily throttled
  | "degraded"       // last call failed with a transient error (5xx/network), not specifically a rate limit
  | "disabled"       // turned off by policy (a settings/allow-list decision), regardless of credential
  | "stub";          // deterministic, network-free adapter (local mode, tests, explicit dev opt-in)
```

`src/components/os/status.tsx`'s `ProviderStateBadge`/`PROVIDER_STATE` map all seven to a tone:
`connected` → ok, `not_configured`/`disabled` → neutral, `rate_limited`/`degraded` → warn,
`unavailable` → danger, `stub` → outline.

## Registries

* `createBrowserRegistry()` — stubs only; used by the embedded gateway in local mode. It cannot hold a credential.
* `createServerRegistry(env)` — live adapters from server env; unconfigured providers are registered as
  `not_configured` so the router records the skip explicitly. `CTOS_ALLOW_STUB_PROVIDERS=1` (dev only)
  substitutes stubs for unconfigured providers so the full server path can be exercised without spending tokens.

## Router and fallback

`ModelRouter.execute(request)`:

1. Sequence = preferred, then fallbacks (de-duplicated).
2. Exclude: not registered · disabled in settings · missing a required capability · `availability()` false.
3. `rankCandidates()` (`src/ai/ranking.ts`) orders the survivors by a deterministic, explainable score
   and records `reasons[]` per candidate — see `docs/PROVIDER-ROUTING.md` and
   `docs/INTELLIGENCE-MODEL.md`.
4. Try in ranked order. After each answer, **validate** against `requiredOutputSchema`. A refusal or a
   failed validation is a failed attempt — the next provider is tried.
5. Every attempt is recorded in policy order with outcome (`succeeded | failed | failed_validation |
   skipped`), model, latency, usage, validation issues, error category and `selectionReason`.
   Execution history reads e.g. *Claude — failed validation · OpenAI — completed*. No silent switching.
6. If nothing succeeds: `NoProviderAvailableError` with all attempts → job `FAILED` / `FAILED_VALIDATION`.

## Structured output validation

`src/schemas/artifacts.ts` holds one Zod schema per artifact type and version:
`project_brief@1 · research_report@1 · site_blueprint@1 · design_system@1 · content_pack@1 ·
build_plan@1 · build_report@1 · qa_report@1 · client_feedback@1 · deployment_report@1 ·
lesson_candidate@1 · other@1`. Each has an `example` (validated at load; returned by stubs).
`validateOutput(name, output)` never throws and returns path-level issues. A provider response becomes
an artifact **only** after validation; the validated (parsed) value is what is stored.

## Agent continuity

The agent is the unit of identity; the provider is a runtime choice. What stays in CT-OS regardless of
provider: the agent's code/name/role, its permission tier, the approved knowledge it receives, the
artifacts it consumes, the handoff it is fulfilling, and the artifact lineage it produces
(`createdByAgentId` is the agent; `createdByProvider` merely records who executed). This is tested
explicitly with the deterministic `StubProvider` (`gateway.test.ts › agent continuity`) and, in
CTOS-003, through the real adapter classes (`src/__tests__/live-continuity-h.test.ts`): Agent 02
executed by the real `ClaudeProvider` and then, with Claude made unavailable, by the real
`OpenAIProvider` receives the identical agent identity, knowledge and inputs, and produces v2 of the
same artifact lineage on the same handoff — only provider provenance (`providerId`/`model`) changes.

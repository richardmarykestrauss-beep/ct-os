# Provider Adapters

Providers are interchangeable intelligence behind one interface. Nothing outside `src/ai/providers/*`
knows how any provider is called; nothing outside the execution gateway can hold a provider key.

## The interface

```ts
interface AIProvider {
  id: "claude" | "openai" | "gemini";
  displayName: string;
  capabilities: ProviderCapability[];        // text, structured_output, long_context, vision, code, review
  connected: boolean;                        // live adapter with a credential present
  connectionState: "connected" | "not_configured" | "stub";
  availability(): ProviderAvailability;      // { available: true } | { available: false, reason }
  execute(request: ProviderRequest): Promise<ProviderResponse>;
}
```

`ProviderRequest` = the neutral `ExecutionRequest` + `systemContext` (assembled sections) +
`outputJsonSchema` (JSON Schema for the required output, for providers that accept one).
`ProviderResponse` = `{ providerId, model, output, summary, usage, finishReason }`. Anything else a
provider returns stays inside the adapter.

## Adapters in CTOS-002

| Provider | File | State | Env var (server-side) |
|---|---|---|---|
| OpenAI | `src/ai/providers/openai.ts` | **live** — Chat Completions with `response_format: json_schema` | `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4o-mini`) |
| Claude | `src/ai/providers/claude.ts` | seam (stub) — reported "Not configured" | `ANTHROPIC_API_KEY` |
| Gemini | `src/ai/providers/gemini.ts` | seam (stub) — reported "Not configured" | `GEMINI_API_KEY` |
| Stub | `src/ai/providers/stub.ts` | deterministic; returns the schema example | — |

OpenAI was chosen first because it is the first in the requested order and the only one whose adapter
could be completed cleanly without a credential in this environment (the request/response mapping is
fully unit-tested against a fake transport). **No live external call has been made** — the adapter
reports `not_configured` until `OPENAI_API_KEY` is set on the gateway.

### OpenAI adapter behaviour

* Builds `system` (agent identity + permission + scoped knowledge sections) and `user` (task, input
  artifacts, tools, output contract) messages from the neutral request.
* Sends `response_format: { type: "json_schema", json_schema: { name, schema, strict: false } }` derived
  from the Zod schema; CT-OS still validates the reply itself.
* Normalises: `model`, `usage.prompt_tokens/completion_tokens`, `finish_reason: length → truncated`,
  refusals → `finishReason: "refused"` (never an artifact), non-JSON content → `{ _unparsed }` so
  validation fails with an actionable message.
* Error mapping: 401/403 → `config` (not retryable); 429/5xx → `provider_unavailable`; other → `provider_error`;
  transport errors → `provider_unavailable`. The key is redacted from any error text.
* Timeout 120 s via `AbortController`.

### Adding Claude or Gemini

Implement `AIProvider` in the existing seam file, read the key in `createServerRegistry`, keep the
capability list honest, and return `ProviderResponse`. No other file changes: routing, validation,
fallback, logging, UI and tests already treat every provider the same way.

## Registries

* `createBrowserRegistry()` — stubs only; used by the embedded gateway in local mode. It cannot hold a credential.
* `createServerRegistry(env)` — live adapters from server env; unconfigured providers are registered as
  `not_configured` so the router records the skip explicitly. `CTOS_ALLOW_STUB_PROVIDERS=1` (dev only)
  substitutes stubs for unconfigured providers so the full server path can be exercised without spending tokens.

## Router and fallback

`ModelRouter.execute(request)`:

1. Sequence = preferred, then fallbacks (de-duplicated).
2. Exclude: not registered · disabled in settings · missing a required capability · `availability()` false.
3. Try in order. After each answer, **validate** against `requiredOutputSchema`. A refusal or a failed
   validation is a failed attempt — the next provider is tried.
4. Every attempt is recorded in policy order with outcome (`succeeded | failed | failed_validation |
   skipped`), model, latency, usage, validation issues and error category. Execution history reads e.g.
   *Claude — failed validation · OpenAI — completed*. No silent switching.
5. If nothing succeeds: `NoProviderAvailableError` with all attempts → job `FAILED` / `FAILED_VALIDATION`.

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
explicitly (`gateway.test.ts › agent continuity`): Agent 02 executed by Claude and then, with Claude
unavailable, by OpenAI receives the identical agent identity, knowledge and inputs, and produces v2 of
the same artifact lineage on the same handoff.

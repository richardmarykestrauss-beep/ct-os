# Provider Routing

How CT-OS decides which provider actually executes a job, end to end: capability filtering, an
availability check, deterministic ranking, ordered attempts, validation, and fallback. The
implementation is `ModelRouter` (`src/ai/router.ts`) plus `rankCandidates`/`explainSelection`
(`src/ai/ranking.ts`); see `docs/PROVIDER-ADAPTERS.md` for the adapters themselves and
`docs/INTELLIGENCE-MODEL.md` for `ExecutionPriority`/`ProviderCapability`.

## The pipeline

```
job.preferredProvider, job.fallbackProviders[]
        │  policySequence(): de-duplicated [preferred, ...fallbacks]
        ▼
1. CAPABILITY FILTER (hard gate)
   exclude any provider missing a capability in job.requiredCapabilities
        │
        ▼
2. AVAILABILITY CHECK
   exclude: not registered · disabled in settings (enabledProviders allow-list)
          · provider.availability() reports { available: false }
        │
        ▼
3. rankCandidates() — deterministic, explainable scoring (soft, never excludes)
   +10 preferred · +2 per priority-bonus capability present · COST/SPEED tie-break tiers
   → ordered list + reasons[] per candidate
        │
        ▼
4. ATTEMPT IN RANKED ORDER
   provider.execute(request) → refusal? → failed attempt, try next
        │
        ▼
5. VALIDATE (Zod, against requiredOutputSchema)
   fails? → failed_validation attempt, try next
        │
        ▼
   succeeds → RouterResult { providerId, output, attempts[] }
   nothing succeeds → NoProviderAvailableError { attempts[] }
```

Steps 1–2 are `ModelRouter.plan()`'s exclusion loop; step 3 is the `rank` hook (defaults to
`ai/ranking.ts#defaultRank`); steps 4–5 are `ModelRouter.execute()`'s attempt loop. `plan()` is also
called standalone (by the UI, and by tests) to answer "what would this job do right now" without
executing anything.

## Step 1 — capability filtering (hard gate)

```ts
const missing = request.requiredCapabilities.filter((c) => !provider.capabilities.includes(c));
if (missing.length) { excluded.push({ providerId: id, reason: `missing capability: ${missing.join(", ")}` }); continue; }
```

This is the only place a provider is removed from consideration for lacking a capability. It only
ever looks at `requiredCapabilities` — the CTOS-003 preference capabilities (`reasoning`,
`fast_generation`, `creative_generation`) are never placed in `requiredCapabilities` by any seeded
agent, precisely so they cannot accidentally become a hard gate. See
`docs/INTELLIGENCE-MODEL.md`.

## Step 2 — availability

`provider.availability()` (sync or async) returns `{available: true}` or `{available: false, reason}`.
A live adapter reports unavailable when: no credential (`not_configured`), disabled by policy, no
`fetch` implementation in the runtime, or its `HealthTracker` currently blocks it (`rate_limited` or
`unavailable` — see `docs/PROVIDER-ADAPTERS.md`). Each exclusion, from either step 1 or step 2, is
recorded with its reason in `RoutingDecision.excluded` and surfaces later as a `skipped` attempt.

## Step 3 — `rankCandidates` (soft, explainable scoring)

Only candidates that survived steps 1–2 are ranked; ranking **never re-introduces or removes** a
candidate. Score components (`src/ai/ranking.ts`):

| Contribution | When | Points |
|---|---|---|
| Preferred provider | `provider.id === request.preferredProvider` | +10 |
| Priority-bonus capability | provider has a capability in `PRIORITY_BONUS_CAPABILITIES[priority]` not already required | +2 each |
| Cost tier (COST priority only) | `(4 - COST_TIER[id]) * 2` — `COST_TIER = {gemini:1, openai:2, claude:3}` | up to +6 |
| Speed tier (SPEED priority only) | `(3 - SPEED_TIER[id]) * 2` — `SPEED_TIER = {gemini:1, openai:1, claude:2}` | up to +4 |

`PRIORITY_BONUS_CAPABILITIES = { QUALITY: [reasoning, long_context], BALANCED: [structured_output],
COST: [], SPEED: [fast_generation] }`. A bonus only scores when the provider has the capability **and**
it is not already in `requiredCapabilities` (`provider.capabilities.includes(cap) &&
!request.requiredCapabilities.includes(cap)`) — every seeded agent already requires
`structured_output`, so in the current seed the BALANCED bonus never actually scores for anyone; it
only differentiates candidates for a future agent that doesn't require `structured_output` outright.
Ties keep the original policy order (stable sort) — with no differentiator, the agent's configured
preferred-then-fallback sequence comes out unchanged.

Every candidate also gets one plain reason line per required capability, unconditionally (informational
only — not scored, since surviving step 1 already means the provider has it): `for (const cap of
request.requiredCapabilities) reasons.push(\`${cap} capability\`)`. So a full `reasons` array for a
preferred, QUALITY-priority candidate requiring `text, structured_output, vision` looks like
`["preferred provider for this job", "text capability", "structured_output capability", "vision
capability", "reasoning capability (favoured by QUALITY priority)", "long_context capability
(favoured by QUALITY priority)", "available"]`, and `explainSelection(providerId, ranked)` joins them
into one line:

```
Selected Claude because: + preferred provider for this job + text capability
+ structured_output capability + vision capability + reasoning capability (favoured by QUALITY
priority) + long_context capability (favoured by QUALITY priority) + available
```

`ModelRouter.plan()` returns these as `RoutingDecision.reasons: Partial<Record<ProviderId, string[]>>`
alongside `order` (the ranked provider ids) and `excluded`. `ModelRouter.execute()` turns each ranked
candidate's `reasons` into a `+ `-joined `selectionReason` string and attaches it to every attempt for
that provider — including a `skipped` attempt for a provider that was excluded before ranking, which
gets `selectionReason: null` (there was nothing to rank).

## Step 4/5 — attempt, validate, fall through

Providers are tried in ranked order. `provider.execute(request)`:

* A refusal (`finishReason: "refused"`) is recorded as a `failed` attempt (category
  `provider_error`) and the next provider is tried.
* A thrown `ProviderError` is recorded as `failed` with the adapter's own `category`
  (`config`/`provider_unavailable`/`provider_error`/etc.) and the next provider is tried.
* A successful response is validated against `requiredOutputSchema` (`src/schemas/artifacts.ts`,
  Zod). A validation failure is recorded as `failed_validation` (with the parsed issues and the raw
  output, for diagnosis) and the next provider is tried.
* The first attempt that validates wins: `RouterResult { providerId, response, output (validated,
  parsed value), validation, attempts }`.

If every candidate is skipped, fails, or fails validation, `ModelRouter.execute()` throws
`NoProviderAvailableError(jobId, attempts)` — every attempt (including the skipped ones from steps
1–2) is attached, in policy order (`orderAttempts`), so execution history always shows the complete
picture, e.g. *Claude — skipped (missing capability: vision) · OpenAI — failed validation · Gemini —
succeeded*.

## How `executionPriority` flows end to end

```
Agent.defaultPriority (optional, e.g. "QUALITY" on Agent 03/08)
        │  createJob(): input.executionPriority ?? agent.defaultPriority ?? "BALANCED"
        ▼
AgentJob.executionPriority (optional; treat absent as "BALANCED")
        │  buildExecutionRequest(): job.executionPriority ?? "BALANCED"
        ▼
ExecutionRequest.executionPriority (always present)
        │  ModelRouter.plan()/execute() pass the request straight to rank()
        ▼
rankCandidates(candidates, request) reads request.executionPriority
```

At every hand-off the fallback is `"BALANCED"`, never an error — a job created before CTOS-003, or one
whose agent never set a `defaultPriority`, routes exactly as CTOS-002 did (preferred-then-fallback
order, no capability-based reordering beyond the hard gate).

## Example "why selected" strings

* Agent 03 (Creative Director, `defaultPriority: QUALITY`, requires `text, structured_output,
  vision`), preferred Claude, fallbacks `[openai, gemini]`, all three available. Claude's default
  capability set (`DEFAULT_CAPABILITIES.claude` in `src/ai/providers/stub.ts`) includes both
  `reasoning` and `long_context`, so both score as QUALITY bonuses:
  `Selected Claude because: + preferred provider for this job + text capability + structured_output
  capability + vision capability + reasoning capability (favoured by QUALITY priority) +
  long_context capability (favoured by QUALITY priority) + available`.
* Agent 02 (UX & Conversion Architect, `defaultPriority: BALANCED`, requires `text,
  structured_output`), preferred Claude unavailable (rate-limited), fallback OpenAI available. Claude
  appears as a `skipped` attempt (`error: "rate limited — cooling down"`, `selectionReason: null`).
  BALANCED's only bonus capability is `structured_output`, which Agent 02 already requires, so it
  scores nothing here — OpenAI wins purely because Claude was excluded before ranking:
  `Selected OpenAI because: + fallback (position 2 in the policy sequence) + text capability +
  structured_output capability + available`.
* Agent 06 (QA & Launch Auditor, no `defaultPriority` set → `BALANCED`, requires `text,
  structured_output, vision, review`), preferred OpenAI available:
  `Selected OpenAI because: + preferred provider for this job + text capability + structured_output
  capability + vision capability + review capability + available`.

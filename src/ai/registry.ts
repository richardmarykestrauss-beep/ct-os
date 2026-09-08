/**
 * Provider registries — the only place that knows which concrete adapters exist.
 *
 *  - createBrowserRegistry(): stubs only. Used by the embedded gateway in local mode. It has no
 *    way to hold a credential, by construction.
 *  - createServerRegistry(env): live adapters built from server-side secrets. Used by the
 *    execution gateway (Edge Function / dev middleware). Secrets never leave this function's
 *    closure except into the adapter that needs them.
 */
import type { ProviderId } from "@/data/types";
import type { AIProvider, ProviderConnectionState } from "./types";
import { ClaudeProvider, CLAUDE_ENV_VAR } from "./providers/claude";
import { GeminiProvider, GEMINI_ENV_VAR } from "./providers/gemini";
import { OpenAIProvider, OPENAI_ENV_VAR, OPENAI_MODEL_ENV_VAR, type FetchLike } from "./providers/openai";
import { StubProvider, notConfigured } from "./providers/stub";

export const PROVIDER_IDS: ProviderId[] = ["claude", "openai", "gemini"];

export const PROVIDER_LABELS: Record<ProviderId, string> = { claude: "Claude", openai: "OpenAI", gemini: "Gemini" };

/** Env var each provider reads server-side. Names only — never values. */
export const PROVIDER_ENV_VARS: Record<ProviderId, string> = { claude: CLAUDE_ENV_VAR, openai: OPENAI_ENV_VAR, gemini: GEMINI_ENV_VAR };

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  state: ProviderConnectionState;
  available: boolean;
  reason: string | null;
  envVar: string;
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, AIProvider>();

  constructor(providers: AIProvider[] = []) {
    for (const p of providers) this.register(p);
  }

  register(provider: AIProvider) {
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: ProviderId): AIProvider | undefined {
    return this.providers.get(id);
  }

  all(): AIProvider[] {
    return [...this.providers.values()];
  }

  /** Safe to send to the browser: no credential, only state and reason. */
  async status(): Promise<ProviderStatus[]> {
    const out: ProviderStatus[] = [];
    for (const id of PROVIDER_IDS) {
      const p = this.providers.get(id);
      if (!p) {
        out.push({ id, label: PROVIDER_LABELS[id], state: "not_configured", available: false, reason: "not registered", envVar: PROVIDER_ENV_VARS[id] });
        continue;
      }
      const a = await p.availability();
      out.push({ id, label: PROVIDER_LABELS[id], state: p.connectionState, available: a.available, reason: a.available ? null : a.reason, envVar: PROVIDER_ENV_VARS[id] });
    }
    return out;
  }
}

/** Local-mode registry: deterministic stubs, no secrets possible. */
export function createBrowserRegistry(): ProviderRegistry {
  return new ProviderRegistry([new StubProvider({ id: "claude" }), new StubProvider({ id: "openai" }), new StubProvider({ id: "gemini" })]);
}

export type ServerEnv = Record<string, string | undefined>;

export interface ServerRegistryOptions {
  fetch?: FetchLike;
}

/**
 * Gateway registry. Reads provider credentials from the server environment. A provider without a
 * credential is registered as "not configured" so the router records the skip explicitly.
 * CTOS_ALLOW_STUB_PROVIDERS=1 swaps unconfigured providers for deterministic stubs (dev only).
 */
export function createServerRegistry(env: ServerEnv, opts: ServerRegistryOptions = {}): ProviderRegistry {
  const allowStubs = env.CTOS_ALLOW_STUB_PROVIDERS === "1" || env.CTOS_ALLOW_STUB_PROVIDERS === "true";
  const openaiKey = env[OPENAI_ENV_VAR]?.trim();
  const providers: AIProvider[] = [];
  providers.push(openaiKey ? new OpenAIProvider({ apiKey: openaiKey, model: env[OPENAI_MODEL_ENV_VAR], fetch: opts.fetch }) : allowStubs ? new StubProvider({ id: "openai" }) : notConfigured("openai", OPENAI_ENV_VAR));
  // Claude and Gemini adapters are seams in CTOS-002: their keys are reported but no live call exists yet.
  providers.push(allowStubs ? new ClaudeProvider() : notConfigured("claude", CLAUDE_ENV_VAR));
  providers.push(allowStubs ? new GeminiProvider() : notConfigured("gemini", GEMINI_ENV_VAR));
  return new ProviderRegistry(providers);
}

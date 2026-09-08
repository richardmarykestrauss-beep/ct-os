/**
 * Provider registry — the only place that knows which concrete adapters exist.
 */
import type { ProviderId } from "@/data/types";
import type { AIProvider } from "./types";
import { ClaudeProvider } from "./providers/claude";
import { OpenAIProvider } from "./providers/openai";
import { GeminiProvider } from "./providers/gemini";

export const PROVIDER_IDS: ProviderId[] = ["claude", "openai", "gemini"];

export const PROVIDER_LABELS: Record<ProviderId, string> = { claude: "Claude", openai: "OpenAI", gemini: "Gemini" };

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
}

function envFlag(name: string): boolean {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return typeof env[name] === "string" && env[name]!.length > 0;
}

/**
 * Default registry: every provider is a stub. `configured` only reports whether a key
 * is present in the environment; no adapter reads or sends it in Phase 1.
 */
export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    new ClaudeProvider({ configured: envFlag("VITE_ANTHROPIC_API_KEY") }),
    new OpenAIProvider({ configured: envFlag("VITE_OPENAI_API_KEY") }),
    new GeminiProvider({ configured: envFlag("VITE_GEMINI_API_KEY") }),
  ]);
}

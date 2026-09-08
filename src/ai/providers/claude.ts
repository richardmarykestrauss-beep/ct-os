/**
 * ClaudeProvider — Anthropic adapter seam.
 * CTOS-002: still a stub. The real implementation will live HERE (server-side only), read
 * ANTHROPIC_API_KEY from the gateway environment and implement the same AIProvider interface
 * the OpenAI adapter does. Nothing else in CT-OS changes when it lands.
 */
import { StubProvider, type StubProviderOptions } from "./stub";

export type ClaudeProviderOptions = Partial<Omit<StubProviderOptions, "id">>;

export class ClaudeProvider extends StubProvider {
  constructor(opts: ClaudeProviderOptions = {}) {
    super({ id: "claude", ...opts });
  }
}

export const CLAUDE_ENV_VAR = "ANTHROPIC_API_KEY";

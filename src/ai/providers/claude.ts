/**
 * ClaudeProvider — Anthropic adapter seam.
 * Phase 1: stub only. The real implementation will import the Anthropic SDK HERE and nowhere else.
 */
import { StubProvider, type StubProviderOptions } from "./stub";

export type ClaudeProviderOptions = Partial<Omit<StubProviderOptions, "id">>;

export class ClaudeProvider extends StubProvider {
  constructor(opts: ClaudeProviderOptions = {}) {
    super({
      id: "claude",
      displayName: "Claude",
      capabilities: ["text", "structured_output", "long_context", "vision", "code", "review"],
      ...opts,
    });
  }
}

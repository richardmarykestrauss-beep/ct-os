/**
 * GeminiProvider — Google Gemini adapter seam.
 * Phase 1: stub only. The real implementation will import the Google GenAI SDK HERE and nowhere else.
 */
import { StubProvider, type StubProviderOptions } from "./stub";

export type GeminiProviderOptions = Partial<Omit<StubProviderOptions, "id">>;

export class GeminiProvider extends StubProvider {
  constructor(opts: GeminiProviderOptions = {}) {
    super({
      id: "gemini",
      displayName: "Gemini",
      capabilities: ["text", "structured_output", "long_context", "vision", "review"],
      ...opts,
    });
  }
}

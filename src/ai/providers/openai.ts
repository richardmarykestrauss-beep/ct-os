/**
 * OpenAIProvider — OpenAI adapter seam.
 * Phase 1: stub only. The real implementation will import the OpenAI SDK HERE and nowhere else.
 */
import { StubProvider, type StubProviderOptions } from "./stub";

export type OpenAIProviderOptions = Partial<Omit<StubProviderOptions, "id">>;

export class OpenAIProvider extends StubProvider {
  constructor(opts: OpenAIProviderOptions = {}) {
    super({
      id: "openai",
      displayName: "OpenAI",
      capabilities: ["text", "structured_output", "vision", "code", "review"],
      ...opts,
    });
  }
}

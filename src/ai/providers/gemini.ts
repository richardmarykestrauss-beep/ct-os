/**
 * GeminiProvider — Google Gemini adapter seam.
 * CTOS-002: still a stub. The real implementation will live HERE (server-side only), read
 * GEMINI_API_KEY from the gateway environment and implement the same AIProvider interface.
 */
import { StubProvider, type StubProviderOptions } from "./stub";

export type GeminiProviderOptions = Partial<Omit<StubProviderOptions, "id">>;

export class GeminiProvider extends StubProvider {
  constructor(opts: GeminiProviderOptions = {}) {
    super({ id: "gemini", ...opts });
  }
}

export const GEMINI_ENV_VAR = "GEMINI_API_KEY";

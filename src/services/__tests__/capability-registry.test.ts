import { describe, it, expect } from "vitest";
import {
  isKnownCapability,
  assertKnownCapabilities,
  providerSatisfies,
  selectCapableProvider,
  capabilityGapDiagnostic,
  ALL_CAPABILITIES,
  CAPABILITY_DESCRIPTIONS,
} from "../capability-registry";
import type { ProviderId } from "@/data/types";

describe("isKnownCapability", () => {
  it("accepts all valid capabilities", () => {
    for (const cap of ALL_CAPABILITIES) {
      expect(isKnownCapability(cap)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isKnownCapability("seo")).toBe(false);
    expect(isKnownCapability("")).toBe(false);
    expect(isKnownCapability("TEXT")).toBe(false);
    expect(isKnownCapability("long context")).toBe(false);
  });
});

describe("assertKnownCapabilities", () => {
  it("does not throw for known capabilities", () => {
    expect(() => assertKnownCapabilities(["text", "code"])).not.toThrow();
  });

  it("throws for unknown capability", () => {
    expect(() => assertKnownCapabilities(["text", "seo"])).toThrow(/seo/);
  });

  it("includes all unknown capabilities in the error", () => {
    expect(() => assertKnownCapabilities(["seo", "translation"])).toThrow(/seo.*translation|translation.*seo/);
  });
});

describe("providerSatisfies", () => {
  it("claude satisfies text capability", () => {
    expect(providerSatisfies("claude", ["text"])).toBe(true);
  });

  it("override caps take precedence over defaults", () => {
    const overrides: Partial<Record<ProviderId, any>> = { claude: ["text", "vision", "code"] };
    expect(providerSatisfies("claude", ["vision"], overrides)).toBe(true);
  });

  it("requires ALL capabilities (AND, not OR)", () => {
    // fast_generation is not in claude's default caps
    expect(providerSatisfies("claude", ["text", "fast_generation"])).toBe(false);
    expect(providerSatisfies("claude", ["text", "structured_output"])).toBe(true);
  });

  it("returns false for provider with empty override caps", () => {
    const overrides: Partial<Record<ProviderId, any>> = { claude: [] };
    expect(providerSatisfies("claude", ["text"], overrides)).toBe(false);
  });

  it("returns true when provider satisfies single capability via override", () => {
    const overrides: Partial<Record<ProviderId, any>> = { openai: ["text", "vision", "code"] };
    expect(providerSatisfies("openai", ["vision"], overrides)).toBe(true);
  });
});

describe("selectCapableProvider", () => {
  it("selects first provider that satisfies all requirements", () => {
    const overrides: Partial<Record<ProviderId, any>> = {
      claude: ["text", "structured_output"],
      openai: ["text", "structured_output", "vision"],
    };
    const result = selectCapableProvider(["claude", "openai"], ["vision"], overrides);
    expect(result).toBe("openai");
  });

  it("returns null when no provider satisfies requirements", () => {
    const overrides: Partial<Record<ProviderId, any>> = { claude: ["text"] };
    const result = selectCapableProvider(["claude"], ["vision"], overrides);
    expect(result).toBeNull();
  });

  it("returns null for empty provider list", () => {
    const result = selectCapableProvider([], ["text"]);
    expect(result).toBeNull();
  });

  it("prefers earlier provider in ordered list", () => {
    const overrides: Partial<Record<ProviderId, any>> = {
      claude: ["text"],
      openai: ["text"],
    };
    const result = selectCapableProvider(["claude", "openai"], ["text"], overrides);
    expect(result).toBe("claude");
  });
});

describe("capabilityGapDiagnostic", () => {
  it("reports which providers are missing which capabilities", () => {
    const overrides: Partial<Record<ProviderId, any>> = {
      claude: ["text"],
      openai: ["text", "vision"],
    };
    const diag = capabilityGapDiagnostic(["vision", "long_context"], ["claude", "openai"], overrides);
    expect(diag).toContain("vision");
    expect(diag).toContain("claude");
    expect(diag).toContain("openai");
  });

  it("notes when a provider satisfies all", () => {
    const overrides: Partial<Record<ProviderId, any>> = { claude: ["text"] };
    const diag = capabilityGapDiagnostic(["text"], ["claude"], overrides);
    expect(diag).toContain("satisfies all");
  });
});

describe("CAPABILITY_DESCRIPTIONS", () => {
  it("has a description for every capability in ALL_CAPABILITIES", () => {
    for (const cap of ALL_CAPABILITIES) {
      expect(CAPABILITY_DESCRIPTIONS[cap]).toBeTruthy();
    }
  });

  it("ALL_CAPABILITIES is non-empty", () => {
    expect(ALL_CAPABILITIES.length).toBeGreaterThan(0);
  });
});

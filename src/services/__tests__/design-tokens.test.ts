import { describe, it, expect } from "vitest";
import {
  REQUIRED_TOKEN_KINDS,
  validateTokenSet,
  getToken,
  tokensByKind,
  createDesignTokenSet,
  approveDesignTokenSet,
  activeDesignTokenSet,
} from "../design-tokens";
import type { DesignToken, DesignTokenSet, OSData } from "@/data/types";
import { EMPTY } from "@/gateway/core";

const baseData = (): OSData => ({ ...EMPTY });

function makeTokenSet(id: string, projectId: string, tokens: DesignToken[], version = 1): DesignTokenSet {
  return { id, projectId, version, tokens, approvedBy: null, approvedAt: null, createdAt: null };
}

// ---------------------------------------------------------------------------
// REQUIRED_TOKEN_KINDS
// ---------------------------------------------------------------------------
describe("REQUIRED_TOKEN_KINDS", () => {
  it("includes color, typography, and spacing", () => {
    expect(REQUIRED_TOKEN_KINDS).toContain("color");
    expect(REQUIRED_TOKEN_KINDS).toContain("typography");
    expect(REQUIRED_TOKEN_KINDS).toContain("spacing");
  });
});

// ---------------------------------------------------------------------------
// validateTokenSet
// ---------------------------------------------------------------------------
describe("validateTokenSet", () => {
  it("valid when all required kinds present", () => {
    const tokens: DesignToken[] = [
      { key: "color-primary", value: "#1A2B3C", kind: "color", usage: "Primary brand" },
      { key: "font-body", value: "Inter, sans-serif", kind: "typography", usage: "Body text" },
      { key: "space-base", value: "8px", kind: "spacing", usage: "Base grid unit" },
    ];
    const result = validateTokenSet(makeTokenSet("ts-1", "proj-1", tokens));
    expect(result.valid).toBe(true);
    expect(result.missingKinds).toHaveLength(0);
  });

  it("invalid when color is missing", () => {
    const tokens: DesignToken[] = [
      { key: "font-body", value: "Inter", kind: "typography", usage: "Body text" },
      { key: "space-base", value: "8px", kind: "spacing", usage: "Base" },
    ];
    const result = validateTokenSet(makeTokenSet("ts-1", "proj-1", tokens));
    expect(result.valid).toBe(false);
    expect(result.missingKinds).toContain("color");
  });

  it("invalid for empty token set", () => {
    const result = validateTokenSet(makeTokenSet("ts-empty", "proj-1", []));
    expect(result.valid).toBe(false);
    expect(result.missingKinds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// getToken / tokensByKind
// ---------------------------------------------------------------------------
describe("getToken", () => {
  it("finds a token by key", () => {
    const set = makeTokenSet("ts-1", "proj-1", [{ key: "color-primary", value: "#000", kind: "color", usage: "Primary" }]);
    expect(getToken(set, "color-primary")?.value).toBe("#000");
  });

  it("returns undefined for missing key", () => {
    const set = makeTokenSet("ts-1", "proj-1", []);
    expect(getToken(set, "nonexistent")).toBeUndefined();
  });
});

describe("tokensByKind", () => {
  it("filters to the specified kind", () => {
    const tokens: DesignToken[] = [
      { key: "color-primary", value: "#000", kind: "color", usage: "" },
      { key: "color-secondary", value: "#FFF", kind: "color", usage: "" },
      { key: "font-body", value: "Inter", kind: "typography", usage: "" },
    ];
    const set = makeTokenSet("ts-1", "proj-1", tokens);
    expect(tokensByKind(set, "color")).toHaveLength(2);
    expect(tokensByKind(set, "typography")).toHaveLength(1);
    expect(tokensByKind(set, "spacing")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createDesignTokenSet
// ---------------------------------------------------------------------------
describe("createDesignTokenSet", () => {
  it("adds token set to OSData", () => {
    const data = baseData();
    const input = { id: "ts-1", projectId: "proj-1", version: 1, tokens: [] };
    const { data: updated, tokenSet } = createDesignTokenSet(data, input);
    expect(updated.designTokenSets).toHaveLength(1);
    expect(tokenSet.approvedBy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// approveDesignTokenSet
// ---------------------------------------------------------------------------
describe("approveDesignTokenSet", () => {
  it("marks the token set as approved", () => {
    const data = baseData();
    const { data: withSet } = createDesignTokenSet(data, { id: "ts-1", projectId: "proj-1", version: 1, tokens: [] });
    const { data: approved, tokenSet } = approveDesignTokenSet(withSet, "ts-1", "Richard", "2024-06-01T00:00:00Z");
    expect(tokenSet.approvedBy).toBe("Richard");
    expect(approved.designTokenSets[0]!.approvedBy).toBe("Richard");
  });

  it("throws when token set not found", () => {
    expect(() => approveDesignTokenSet(baseData(), "missing", "Richard", "2024-01-01T00:00:00Z")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// activeDesignTokenSet
// ---------------------------------------------------------------------------
describe("activeDesignTokenSet", () => {
  it("returns the approved set with the highest version", () => {
    let data = baseData();
    ({ data } = createDesignTokenSet(data, { id: "ts-1", projectId: "proj-1", version: 1, tokens: [] }));
    ({ data } = createDesignTokenSet(data, { id: "ts-2", projectId: "proj-1", version: 2, tokens: [] }));
    ({ data } = approveDesignTokenSet(data, "ts-1", "Richard", "2024-01-01T00:00:00Z"));
    ({ data } = approveDesignTokenSet(data, "ts-2", "Richard", "2024-06-01T00:00:00Z"));
    const active = activeDesignTokenSet(data, "proj-1");
    expect(active?.id).toBe("ts-2");
  });

  it("returns undefined when no approved set exists", () => {
    const data = baseData();
    expect(activeDesignTokenSet(data, "proj-1")).toBeUndefined();
  });
});

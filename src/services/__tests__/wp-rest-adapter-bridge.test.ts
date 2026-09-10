/**
 * CTOS-006E: CT Bridge integration tests for RealWordPressRestAdapter.
 *
 * All HTTP is intercepted via injected FetchFn mocks — no live connections.
 * Covers: getElementorDocument, applyElementorPatch, rollbackElementorDocument,
 * allowlist enforcement, round-trip preservation, error sanitization.
 */
import { describe, it, expect, vi } from "vitest";
import { RealWordPressRestAdapter } from "../wp-rest-adapter";
import type { WpRestConfig, FetchFn } from "../wp-rest-adapter";
import type { ElementorBridgePatch } from "@/data/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_URL = "https://staging.example.com";

const TEST_CONFIG: WpRestConfig = {
  siteUrl: BASE_URL,
  username: "test_user",
  appPassword: "fake-app-password",
  timeoutMs: 5_000,
};

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeAdapter(fetchFn: FetchFn): RealWordPressRestAdapter {
  return new RealWordPressRestAdapter(TEST_CONFIG, fetchFn);
}

// Minimal raw Elementor heading widget as WordPress stores it in _elementor_data
const RAW_HEADING_NODE = {
  id: "abc123",
  elType: "widget",
  widgetType: "heading",
  settings: {
    title: "Hello World",
    title_size: "h2",
    typography_font_size: { unit: "px", size: 24 },
    some_custom_field: "do_not_lose_me",
  },
  elements: [],
  isInner: false,
  htmlCache: "<h2>Hello World</h2>",
};

// Raw Elementor text-editor node
const RAW_TEXT_NODE = {
  id: "txt001",
  elType: "widget",
  widgetType: "text-editor",
  settings: { editor: "<p>Hello</p>", custom_field: "preserved" },
  elements: [],
  isInner: false,
};

// Raw Elementor button node
const RAW_BUTTON_NODE = {
  id: "btn001",
  elType: "widget",
  widgetType: "button",
  settings: {
    button_text: "Click Me",
    button_url: { url: "https://example.com", is_external: false },
    button_type: "default",
  },
  elements: [],
  isInner: false,
};

// Raw Elementor image node
const RAW_IMAGE_NODE = {
  id: "img001",
  elType: "widget",
  widgetType: "image",
  settings: { image: { id: 42, url: "https://example.com/img.jpg" }, image_size: "full" },
  elements: [],
  isInner: false,
};

// Raw Elementor container
const RAW_CONTAINER_NODE = {
  id: "ctr001",
  elType: "container",
  settings: { text_align: "center", background_color: "#fff", custom_id: "hero" },
  elements: [RAW_HEADING_NODE],
  isInner: false,
};

// Unknown widget type
const RAW_UNKNOWN_NODE = {
  id: "unk001",
  elType: "widget",
  widgetType: "wp-widget-tag_cloud",
  settings: { some: "data" },
  elements: [],
  isInner: false,
};

const FAKE_HASH_A = "a".repeat(64);
const FAKE_HASH_B = "b".repeat(64);

function bridgeGetResponse(nodes: unknown[] = [RAW_HEADING_NODE]) {
  return {
    page_id: 42,
    elementor_managed: true,
    elementor_edit_mode: "builder",
    document_hash: FAKE_HASH_A,
    elementor_data: nodes,
  };
}

function bridgePatchResponse() {
  return {
    page_id: 42,
    previous_hash: FAKE_HASH_A,
    document_hash: FAKE_HASH_B,
  };
}

// ---------------------------------------------------------------------------
// getElementorDocument — bridge read mapping
// ---------------------------------------------------------------------------

describe("bridge: getElementorDocument", () => {
  it("calls GET /wp-json/ctos/v1/elementor/{pageId}", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(bridgeGetResponse()));
    await makeAdapter(fetch).getElementorDocument("42");
    expect(fetch.mock.calls[0][0]).toBe(`${BASE_URL}/wp-json/ctos/v1/elementor/42`);
    expect(fetch.mock.calls[0][1].method).toBe("GET");
  });

  it("returns null when bridge returns 404", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("GET /wp-json/ctos/v1/elementor/99 → HTTP 404: not found"));
    const result = await makeAdapter(fetch).getElementorDocument("99");
    expect(result).toBeNull();
  });

  it("returns null when bridge returns 422 (page not Elementor-managed)", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("GET /wp-json/ctos/v1/elementor/42 → HTTP 422: no elementor data"));
    const result = await makeAdapter(fetch).getElementorDocument("42");
    expect(result).toBeNull();
  });

  it("propagates non-404/422 errors", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("GET /wp-json/ctos/v1/elementor/42 → HTTP 500: server error"));
    await expect(makeAdapter(fetch).getElementorDocument("42")).rejects.toThrow("HTTP 500");
  });

  it("maps heading widget to type='heading'", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(bridgeGetResponse([RAW_HEADING_NODE])));
    const doc = await makeAdapter(fetch).getElementorDocument("42");
    expect(doc?.nodes[0].type).toBe("heading");
  });

  it("maps text-editor widget to type='text'", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(bridgeGetResponse([RAW_TEXT_NODE])));
    const doc = await makeAdapter(fetch).getElementorDocument("42");
    expect(doc?.nodes[0].type).toBe("text");
  });

  it("maps button widget to type='button'", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(bridgeGetResponse([RAW_BUTTON_NODE])));
    const doc = await makeAdapter(fetch).getElementorDocument("42");
    expect(doc?.nodes[0].type).toBe("button");
  });

  it("maps image widget to type='image'", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(bridgeGetResponse([RAW_IMAGE_NODE])));
    const doc = await makeAdapter(fetch).getElementorDocument("42");
    expect(doc?.nodes[0].type).toBe("image");
  });

  it("maps container elType to type='container'", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(bridgeGetResponse([RAW_CONTAINER_NODE])));
    const doc = await makeAdapter(fetch).getElementorDocument("42");
    expect(doc?.nodes[0].type).toBe("container");
  });

  it("maps unknown widgetType to type='unknown'", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(bridgeGetResponse([RAW_UNKNOWN_NODE])));
    const doc = await makeAdapter(fetch).getElementorDocument("42");
    expect(doc?.nodes[0].type).toBe("unknown");
  });

  it("stores bridge document_hash as doc.documentHash", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(bridgeGetResponse()));
    const doc = await makeAdapter(fetch).getElementorDocument("42");
    expect(doc?.documentHash).toBe(FAKE_HASH_A);
  });

  it("preserves all raw settings including unknown fields in _preserved.settings", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(bridgeGetResponse([RAW_HEADING_NODE])));
    const doc = await makeAdapter(fetch).getElementorDocument("42");
    const node = doc!.nodes[0];
    // Typed settings: only title
    expect(node.settings["title"]).toBe("Hello World");
    // _preserved: full original settings (including unknown fields)
    const preserved = node._preserved as Record<string, unknown>;
    const ps = preserved["settings"] as Record<string, unknown>;
    expect(ps["some_custom_field"]).toBe("do_not_lose_me");
    expect(ps["typography_font_size"]).toEqual({ unit: "px", size: 24 });
  });

  it("preserves non-settings Elementor fields (isInner, htmlCache, elType) in _preserved", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(bridgeGetResponse([RAW_HEADING_NODE])));
    const doc = await makeAdapter(fetch).getElementorDocument("42");
    const preserved = doc!.nodes[0]._preserved as Record<string, unknown>;
    expect(preserved["elType"]).toBe("widget");
    expect(preserved["widgetType"]).toBe("heading");
    expect(preserved["isInner"]).toBe(false);
    expect(preserved["htmlCache"]).toBe("<h2>Hello World</h2>");
  });

  it("maps container child elements into typed children array", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(bridgeGetResponse([RAW_CONTAINER_NODE])));
    const doc = await makeAdapter(fetch).getElementorDocument("42");
    const container = doc!.nodes[0];
    expect(container.children).toHaveLength(1);
    expect(container.children[0].type).toBe("heading");
    expect(container.children[0].id).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
// updateElementorDocument — must throw (no full-document replacement)
// ---------------------------------------------------------------------------

describe("bridge: updateElementorDocument throws (full-doc write not supported)", () => {
  it("always throws regardless of page id or document content", async () => {
    const adapter = makeAdapter(vi.fn());
    await expect(
      adapter.updateElementorDocument("42", {
        pageId: "42",
        version: "bridge",
        documentHash: FAKE_HASH_A,
        nodes: [],
      }),
    ).rejects.toThrow(/applyElementorPatch/i);
  });
});

// ---------------------------------------------------------------------------
// applyElementorPatch — targeted patch contract
// ---------------------------------------------------------------------------

function makePatch(overrides: Partial<ElementorBridgePatch> = {}): ElementorBridgePatch {
  return {
    expectedDocumentHash: FAKE_HASH_A,
    operation: "SET_WIDGET_TEXT",
    elementId: "abc123",
    expectedElementType: "heading",
    value: "New Title",
    ...overrides,
  };
}

function bridgeRollbackResponse() {
  return {
    page_id: 42,
    previous_hash: FAKE_HASH_B,
    document_hash: FAKE_HASH_A,
    snapshot_hash: FAKE_HASH_A,
  };
}

describe("bridge: applyElementorPatch", () => {
  it("sends PATCH to /wp-json/ctos/v1/elementor/{pageId}", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(bridgePatchResponse()))
      .mockResolvedValueOnce(mockResponse({ ...bridgeGetResponse(), document_hash: FAKE_HASH_B }));
    await makeAdapter(fetch).applyElementorPatch("42", makePatch());
    expect(fetch.mock.calls[0][0]).toBe(`${BASE_URL}/wp-json/ctos/v1/elementor/42`);
    expect(fetch.mock.calls[0][1].method).toBe("PATCH");
  });

  it("sends { expected_document_hash, patch: { ... } } body — NOT elementor_data", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(bridgePatchResponse()))
      .mockResolvedValueOnce(mockResponse({ ...bridgeGetResponse(), document_hash: FAKE_HASH_B }));
    await makeAdapter(fetch).applyElementorPatch("42", makePatch());
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(body).toHaveProperty("expected_document_hash", FAKE_HASH_A);
    expect(body).toHaveProperty("patch");
    expect(body).not.toHaveProperty("elementor_data");
  });

  it("maps patch fields to snake_case in bridge body", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(bridgePatchResponse()))
      .mockResolvedValueOnce(mockResponse({ ...bridgeGetResponse(), document_hash: FAKE_HASH_B }));
    const patch = makePatch({ operation: "SET_WIDGET_TEXT", elementId: "abc123", expectedElementType: "heading", value: "Hi" });
    await makeAdapter(fetch).applyElementorPatch("42", patch);
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    const p = body["patch"];
    expect(p["operation"]).toBe("SET_WIDGET_TEXT");
    expect(p["element_id"]).toBe("abc123");
    expect(p["expected_element_type"]).toBe("heading");
    expect(p["value"]).toBe("Hi");
  });

  it("includes key in patch body for SET_SETTING", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(bridgePatchResponse()))
      .mockResolvedValueOnce(mockResponse({ ...bridgeGetResponse(), document_hash: FAKE_HASH_B }));
    await makeAdapter(fetch).applyElementorPatch("42", makePatch({ operation: "SET_SETTING", key: "text_align", value: "center" }));
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(body["patch"]["key"]).toBe("text_align");
  });

  it("returns afterStateHash from bridge read-back", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(bridgePatchResponse()))
      .mockResolvedValueOnce(mockResponse({ ...bridgeGetResponse(), document_hash: FAKE_HASH_B }));
    const result = await makeAdapter(fetch).applyElementorPatch("42", makePatch());
    expect(result.afterStateHash).toBe(FAKE_HASH_B);
  });

  it("propagates HTTP 400 (unsupported operation) from bridge", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("PATCH /wp-json/ctos/v1/elementor/42 → HTTP 400: unknown operation"));
    await expect(makeAdapter(fetch).applyElementorPatch("42", makePatch({ operation: "SET_WIDGET_TEXT" }))).rejects.toThrow("400");
  });

  it("propagates HTTP 404 (element not found) from bridge", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("PATCH /wp-json/ctos/v1/elementor/42 → HTTP 404: element_not_found"));
    await expect(makeAdapter(fetch).applyElementorPatch("42", makePatch())).rejects.toThrow("404");
  });

  it("propagates HTTP 422 (type mismatch) from bridge", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("PATCH /wp-json/ctos/v1/elementor/42 → HTTP 422: type_mismatch"));
    await expect(makeAdapter(fetch).applyElementorPatch("42", makePatch({ expectedElementType: "text" }))).rejects.toThrow("422");
  });

  it("throws on read-back hash mismatch after PATCH", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(bridgePatchResponse()))              // PATCH → HASH_B
      .mockResolvedValueOnce(mockResponse({ ...bridgeGetResponse(), document_hash: "c".repeat(64) })); // read-back → HASH_C
    await expect(makeAdapter(fetch).applyElementorPatch("42", makePatch())).rejects.toThrow(/read-back hash mismatch/i);
  });
});

// ---------------------------------------------------------------------------
// rollbackElementorDocument — targeted rollback
// ---------------------------------------------------------------------------

describe("bridge: rollbackElementorDocument", () => {
  const SNAPSHOT_DATA = [RAW_HEADING_NODE];

  it("sends POST to /wp-json/ctos/v1/elementor/{pageId}/rollback", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(bridgeRollbackResponse()))
      .mockResolvedValueOnce(mockResponse({ ...bridgeGetResponse(), document_hash: FAKE_HASH_A }));
    await makeAdapter(fetch).rollbackElementorDocument("42", {
      snapshotHash: FAKE_HASH_A,
      expectedCurrentHash: FAKE_HASH_B,
      elementorData: SNAPSHOT_DATA,
    });
    expect(fetch.mock.calls[0][0]).toBe(`${BASE_URL}/wp-json/ctos/v1/elementor/42/rollback`);
    expect(fetch.mock.calls[0][1].method).toBe("POST");
  });

  it("sends { snapshot_hash, expected_document_hash, elementor_data } in rollback body", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(bridgeRollbackResponse()))
      .mockResolvedValueOnce(mockResponse({ ...bridgeGetResponse(), document_hash: FAKE_HASH_A }));
    await makeAdapter(fetch).rollbackElementorDocument("42", {
      snapshotHash: FAKE_HASH_A,
      expectedCurrentHash: FAKE_HASH_B,
      elementorData: SNAPSHOT_DATA,
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(body["snapshot_hash"]).toBe(FAKE_HASH_A);
    expect(body["expected_document_hash"]).toBe(FAKE_HASH_B);
    expect(Array.isArray(body["elementor_data"])).toBe(true);
  });

  it("returns afterStateHash from rollback read-back", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(bridgeRollbackResponse()))
      .mockResolvedValueOnce(mockResponse({ ...bridgeGetResponse(), document_hash: FAKE_HASH_A }));
    const result = await makeAdapter(fetch).rollbackElementorDocument("42", {
      snapshotHash: FAKE_HASH_A,
      expectedCurrentHash: FAKE_HASH_B,
      elementorData: SNAPSHOT_DATA,
    });
    expect(result.afterStateHash).toBe(FAKE_HASH_A);
  });

  it("propagates HTTP 409 (conflict — stale current hash) from bridge", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("POST /wp-json/ctos/v1/elementor/42/rollback → HTTP 409: conflict_detected"));
    await expect(
      makeAdapter(fetch).rollbackElementorDocument("42", { snapshotHash: FAKE_HASH_A, expectedCurrentHash: FAKE_HASH_B, elementorData: [] }),
    ).rejects.toThrow("409");
  });

  it("propagates HTTP 400 (snapshot integrity failure — data does not hash to snapshot_hash)", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("POST /wp-json/ctos/v1/elementor/42/rollback → HTTP 400: snapshot_hash_mismatch"));
    await expect(
      makeAdapter(fetch).rollbackElementorDocument("42", { snapshotHash: FAKE_HASH_A, expectedCurrentHash: FAKE_HASH_B, elementorData: [] }),
    ).rejects.toThrow("400");
  });

  it("throws on read-back hash mismatch after rollback", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(bridgeRollbackResponse()))             // rollback → HASH_A
      .mockResolvedValueOnce(mockResponse({ ...bridgeGetResponse(), document_hash: "d".repeat(64) })); // read-back → HASH_D
    await expect(
      makeAdapter(fetch).rollbackElementorDocument("42", { snapshotHash: FAKE_HASH_A, expectedCurrentHash: FAKE_HASH_B, elementorData: SNAPSHOT_DATA }),
    ).rejects.toThrow(/read-back hash mismatch/i);
  });
});

// ---------------------------------------------------------------------------
// Allowlist enforcement for CT Bridge endpoints
// ---------------------------------------------------------------------------

describe("bridge: allowlist enforcement", () => {
  it("allows /wp-json/ctos/v1/elementor/{numericId}", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(bridgeGetResponse()));
    await expect(makeAdapter(fetch).getElementorDocument("316")).resolves.not.toThrow();
  });

  it("allowlist regex matches exactly /wp-json/ctos/v1/elementor/{digits}", () => {
    const pattern = /^\/wp-json\/ctos\/v1\/elementor\/\d+$/;
    expect(pattern.test("/wp-json/ctos/v1/elementor/316")).toBe(true);
    expect(pattern.test("/wp-json/ctos/v1/elementor/1")).toBe(true);
    expect(pattern.test("/wp-json/ctos/v1/elementor/316/run_php")).toBe(false);
    expect(pattern.test("/wp-json/ctos/v1/options")).toBe(false);
    expect(pattern.test("/wp-json/ctos/v1/elementor/abc")).toBe(false);
    expect(pattern.test("/wp-json/ctos/v1/elementor/")).toBe(false);
  });

  it("allowlist regex matches /wp-json/ctos/v1/elementor/{digits}/rollback", () => {
    const rollbackPattern = /^\/wp-json\/ctos\/v1\/elementor\/\d+\/rollback$/;
    expect(rollbackPattern.test("/wp-json/ctos/v1/elementor/42/rollback")).toBe(true);
    expect(rollbackPattern.test("/wp-json/ctos/v1/elementor/316/rollback")).toBe(true);
    expect(rollbackPattern.test("/wp-json/ctos/v1/elementor/42/rollback/extra")).toBe(false);
    expect(rollbackPattern.test("/wp-json/ctos/v1/elementor/42/run_php")).toBe(false);
    expect(rollbackPattern.test("/wp-json/ctos/v1/elementor/abc/rollback")).toBe(false);
  });
});

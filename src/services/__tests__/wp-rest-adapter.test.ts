/**
 * CTOS-006R1: RealWordPressRestAdapter unit tests.
 *
 * ALL HTTP is intercepted via an injected FetchFn mock.
 * No live WordPress connection. No credentials in source.
 */
import { describe, it, expect, vi } from "vitest";
import { RealWordPressRestAdapter } from "../wp-rest-adapter";
import type { WpRestConfig } from "../wp-rest-adapter";
import type { FetchFn } from "../wp-rest-adapter";

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

const FAKE_PAGE = {
  id: 42,
  slug: "ct-os-write-test",
  status: "draft",
  title: { rendered: "CT-OS Write Test", raw: "CT-OS Write Test" },
  content: { rendered: "<p>Controlled draft.</p>", raw: "Controlled draft." },
  excerpt: { rendered: "" },
  modified: "2024-01-01T12:00:00",
  modified_gmt: "2024-01-01T12:00:00",
};

const FAKE_USER = { id: 1, name: "test_user", capabilities: { edit_pages: true } };

const FAKE_ROOT = {
  name: "Test WP Site",
  generator: "WordPress 6.5.0",
  namespaces: ["wp/v2", "elementor/v1"],
};

// ---------------------------------------------------------------------------
// verifyConnection
// ---------------------------------------------------------------------------

describe("verifyConnection", () => {
  it("returns online+authOk when both root and users/me succeed", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(FAKE_ROOT))        // /wp-json/
      .mockResolvedValueOnce(mockResponse(FAKE_USER))        // /wp-json/wp/v2/users/me
      .mockResolvedValueOnce(mockResponse(FAKE_ROOT));       // second root for elementor check
    const adapter = makeAdapter(fetch);
    const result = await adapter.verifyConnection();
    expect(result.online).toBe(true);
    expect(result.authOk).toBe(true);
    expect(result.restApiReachable).toBe(true);
    expect(result.error).toBeNull();
  });

  it("returns offline when root request fails", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const adapter = makeAdapter(fetch);
    const result = await adapter.verifyConnection();
    expect(result.online).toBe(false);
    expect(result.authOk).toBe(false);
    expect(result.error).toContain("REST API not reachable");
  });

  it("returns authOk=false on 401 from users/me", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(FAKE_ROOT))
      .mockResolvedValueOnce(mockResponse({ code: "rest_not_logged_in" }, 401));
    const adapter = makeAdapter(fetch);
    const result = await adapter.verifyConnection();
    expect(result.online).toBe(true);
    expect(result.authOk).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("detects Elementor when namespace present", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(FAKE_ROOT))
      .mockResolvedValueOnce(mockResponse(FAKE_USER))
      .mockResolvedValueOnce(mockResponse(FAKE_ROOT));
    const adapter = makeAdapter(fetch);
    const result = await adapter.verifyConnection();
    expect(result.elementorAccessible).toBe(true);
  });

  it("bad credentials error never leaks Authorization header in message", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(FAKE_ROOT))
      .mockResolvedValueOnce(mockResponse({ message: "Invalid credentials" }, 403));
    const adapter = makeAdapter(fetch);
    const result = await adapter.verifyConnection();
    expect(result.error ?? "").not.toMatch(/Basic\s+[A-Za-z0-9+/=]+/i);
    expect(result.error ?? "").not.toContain("fake-app-password");
  });
});

// ---------------------------------------------------------------------------
// createDraftPage — draft-only guarantee
// ---------------------------------------------------------------------------

describe("createDraftPage", () => {
  it("always sends status=draft in request body", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(FAKE_PAGE))         // POST create
      .mockResolvedValueOnce(mockResponse(FAKE_PAGE));        // GET read-back
    const adapter = makeAdapter(fetch);
    await adapter.createDraftPage({ title: "CT-OS Write Test", slug: "ct-os-write-test" });
    const postCall = fetch.mock.calls[0];
    const body = JSON.parse(postCall[1].body as string);
    expect(body.status).toBe("draft");
  });

  it("throws if WordPress returns non-draft status", async () => {
    const publishedPage = { ...FAKE_PAGE, status: "publish" };
    const fetch = vi.fn().mockResolvedValue(mockResponse(publishedPage));
    const adapter = makeAdapter(fetch);
    await expect(
      adapter.createDraftPage({ title: "CT-OS Write Test", slug: "ct-os-write-test" }),
    ).rejects.toThrow(/expected draft/i);
  });

  it("returns pageId, resultToken, afterStateHash", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(FAKE_PAGE))
      .mockResolvedValueOnce(mockResponse(FAKE_PAGE));
    const adapter = makeAdapter(fetch);
    const result = await adapter.createDraftPage({ title: "CT-OS Write Test", slug: "ct-os-write-test" });
    expect(result.pageId).toBe("42");
    expect(result.resultToken).toBeTruthy();
    expect(result.afterStateHash).toBeTruthy();
  });

  it("performs a read-back GET after creation", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(FAKE_PAGE))
      .mockResolvedValueOnce(mockResponse(FAKE_PAGE));
    const adapter = makeAdapter(fetch);
    await adapter.createDraftPage({ title: "CT-OS Write Test", slug: "ct-os-write-test" });
    expect(fetch).toHaveBeenCalledTimes(2);
    const secondCall = fetch.mock.calls[1];
    expect(secondCall[0]).toContain("/wp-json/wp/v2/pages/42");
    expect(secondCall[1].method).toBe("GET");
  });
});

// ---------------------------------------------------------------------------
// updatePageContent — read-back after write
// ---------------------------------------------------------------------------

describe("updatePageContent", () => {
  it("performs PATCH then GET read-back", async () => {
    const updated = { ...FAKE_PAGE, title: { rendered: "CT-OS Write Test — Verified", raw: "CT-OS Write Test — Verified" } };
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(updated))     // PATCH
      .mockResolvedValueOnce(mockResponse(updated));    // GET read-back
    const adapter = makeAdapter(fetch);
    const result = await adapter.updatePageContent("42", { field: "title", value: "CT-OS Write Test — Verified" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].method).toBe("PATCH");
    expect(fetch.mock.calls[1][1].method).toBe("GET");
    expect(result.afterStateHash).toBeTruthy();
  });

  it("resultToken includes pageId and field name", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(FAKE_PAGE))
      .mockResolvedValueOnce(mockResponse(FAKE_PAGE));
    const adapter = makeAdapter(fetch);
    const result = await adapter.updatePageContent("42", { field: "content", value: "Updated" });
    expect(result.resultToken).toContain("42");
    expect(result.resultToken).toContain("content");
  });
});

// ---------------------------------------------------------------------------
// Endpoint allowlist — disallowed URLs must throw
// ---------------------------------------------------------------------------

describe("endpoint allowlist", () => {
  it("allows the CT Bridge elementor endpoint", async () => {
    // getElementorDocument now calls the bridge; a successful mock confirms the
    // endpoint passes the allowlist (if it were blocked, fetch would never be called
    // and an allowlist error would be thrown instead).
    const fetch = vi.fn().mockResolvedValue(mockResponse({
      page_id: 42,
      elementor_managed: true,
      elementor_edit_mode: "builder",
      document_hash: "a".repeat(64),
      elementor_data: [],
    }));
    const adapter = makeAdapter(fetch);
    const result = await adapter.getElementorDocument("42");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toContain("/wp-json/ctos/v1/elementor/42");
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateElementorDocument — unsupported via REST
// ---------------------------------------------------------------------------

describe("updateElementorDocument", () => {
  it("throws — full-document write not supported via CT Bridge (use applyElementorPatch)", async () => {
    const adapter = makeAdapter(vi.fn());
    await expect(
      adapter.updateElementorDocument("42", { pageId: "42", version: "bridge", documentHash: "a".repeat(64), nodes: [] }),
    ).rejects.toThrow(/applyElementorPatch/i);
  });
});

// ---------------------------------------------------------------------------
// Secrets never appear in errors
// ---------------------------------------------------------------------------

describe("secret safety", () => {
  it("network error message strips Basic auth header if present", async () => {
    // Simulate an error that reflects the auth header back — e.g. a proxy error log.
    // We test verifyConnection (the root GET) which does not swallow errors.
    const authVal = "Basic dXNlcjpwYXNz";
    const fetch = vi.fn().mockRejectedValue(new Error(`ENOTFOUND: header=${authVal}`));
    const adapter = makeAdapter(fetch);
    // verifyConnection catches the root error and returns { online: false, error: ... }
    const result = await adapter.verifyConnection();
    expect(result.online).toBe(false);
    // The sanitized error field must not contain the raw Basic token
    expect(result.error ?? "").not.toContain(authVal);
    expect(result.error ?? "").not.toMatch(/Basic\s+[A-Za-z0-9+/=]+/i);
  });

  it("HTTP 401 error does not echo auth header", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(FAKE_ROOT))
      .mockResolvedValueOnce(mockResponse({ message: "rest_not_logged_in: Authorization: Basic abc123" }, 401));
    const adapter = makeAdapter(fetch);
    const result = await adapter.verifyConnection();
    expect(result.error ?? "").not.toContain("Basic abc123");
  });
});

// ---------------------------------------------------------------------------
// createRevisionSnapshot
// ---------------------------------------------------------------------------

describe("createRevisionSnapshot", () => {
  it("returns snapshotToken, revisionId, contentHash", async () => {
    const revisions = [{ id: 7, parent: 42, modified: "2024-01-01T11:00:00", title: { rendered: "v1" } }];
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockResponse(FAKE_PAGE))       // GET current page
      .mockResolvedValueOnce(mockResponse(revisions));      // GET revisions
    const adapter = makeAdapter(fetch);
    const result = await adapter.createRevisionSnapshot("42");
    expect(result.revisionId).toBe("7");
    expect(result.snapshotToken).toContain("42");
    expect(result.contentHash).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Connection timeout
// ---------------------------------------------------------------------------

describe("timeout handling", () => {
  it("propagates network abort as a thrown error (sanitized)", async () => {
    // Node environments reject AbortController aborts with a plain Error whose name is "AbortError"
    const abortErr = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    const fetch = vi.fn().mockRejectedValue(abortErr);
    const adapter = new RealWordPressRestAdapter({ ...TEST_CONFIG, timeoutMs: 5_000 }, fetch);
    // getPage propagates the error (no swallowing) so we can assert on it
    await expect(adapter.getPage("42")).rejects.toThrow();
  });
});

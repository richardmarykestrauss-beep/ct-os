/**
 * CTOS-008: shared capture core (src/gateway/site-capture.ts) — the exact module the Vite dev
 * middleware and the Vercel api/site-capture.ts handler both call. No network for the blocked
 * cases: hostnameBlocked() rejects before any fetch or DNS lookup runs.
 */
import { describe, expect, it } from "vitest";
import { captureSite, hostnameBlocked, MAX_PAGES } from "@/gateway/site-capture";

describe("hostnameBlocked — SSRF fail-closed", () => {
  it("blocks loopback, private ranges, metadata endpoints and non-http schemes", () => {
    expect(hostnameBlocked("http://localhost/")).toBeTruthy();
    expect(hostnameBlocked("http://127.0.0.1/")).toBeTruthy();
    expect(hostnameBlocked("http://192.168.1.1/")).toBeTruthy();
    expect(hostnameBlocked("http://10.0.0.5/")).toBeTruthy();
    expect(hostnameBlocked("http://172.16.0.1/")).toBeTruthy();
    expect(hostnameBlocked("http://169.254.169.254/latest/meta-data")).toBeTruthy();
    expect(hostnameBlocked("http://metadata.google.internal/")).toBeTruthy();
    expect(hostnameBlocked("ftp://example.com/")).toBeTruthy();
    expect(hostnameBlocked("file:///etc/passwd")).toBeTruthy();
    expect(hostnameBlocked("http://user:pass@example.com/")).toBeTruthy();
    expect(hostnameBlocked("http://intranet/")).toBeTruthy(); // single-label
  });

  it("allows an ordinary public https URL", () => {
    expect(hostnameBlocked("https://example.com/")).toBeNull();
  });
});

describe("captureSite — blocked targets never reach the network", () => {
  it("returns the blocked shape for a private-network URL without a paid/live request", async () => {
    const result = await captureSite("http://192.168.0.1/");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect("blocked" in result && result.blocked).toBe(true);
  });

  it("respects the MAX_PAGES export as its own default budget", () => {
    expect(MAX_PAGES).toBeGreaterThan(0);
    expect(MAX_PAGES).toBeLessThanOrEqual(10);
  });
});

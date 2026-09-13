/**
 * CTOS-007A: SSRF-safe URL validation tests.
 * No live HTTP — deterministic inputs only.
 */
import { describe, expect, it } from "vitest";
import { validateAuditUrl } from "@/lib/audit-url";

describe("validateAuditUrl", () => {
  // --- Valid URLs ---
  it("accepts a plain https URL", () => {
    const r = validateAuditUrl("https://example.com");
    expect(r.ok).toBe(true);
  });

  it("accepts a plain http URL", () => {
    const r = validateAuditUrl("http://example.com");
    expect(r.ok).toBe(true);
  });

  it("prepends https when scheme is missing", () => {
    const r = validateAuditUrl("example.com");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalised).toMatch(/^https:\/\//);
  });

  it("normalises trailing slash", () => {
    const r = validateAuditUrl("https://example.com/");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalised).not.toMatch(/\/$/);
  });

  it("lowercases scheme and host", () => {
    const r = validateAuditUrl("HTTPS://EXAMPLE.COM");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalised).toBe("https://example.com");
  });

  // --- Blocked schemes ---
  it("rejects file:// URL", () => {
    const r = validateAuditUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
  });

  it("rejects ftp:// URL", () => {
    const r = validateAuditUrl("ftp://example.com");
    expect(r.ok).toBe(false);
  });

  it("rejects javascript: URL", () => {
    const r = validateAuditUrl("javascript:alert(1)");
    expect(r.ok).toBe(false);
  });

  it("rejects data: URL", () => {
    const r = validateAuditUrl("data:text/html,<h1>hi</h1>");
    expect(r.ok).toBe(false);
  });

  // --- Private/internal hosts ---
  it("rejects localhost", () => {
    const r = validateAuditUrl("http://localhost");
    expect(r.ok).toBe(false);
  });

  it("rejects 127.0.0.1", () => {
    const r = validateAuditUrl("http://127.0.0.1");
    expect(r.ok).toBe(false);
  });

  it("rejects 10.x private range", () => {
    const r = validateAuditUrl("http://10.0.0.1");
    expect(r.ok).toBe(false);
  });

  it("rejects 192.168.x private range", () => {
    const r = validateAuditUrl("http://192.168.1.100");
    expect(r.ok).toBe(false);
  });

  it("rejects 172.16.x private range", () => {
    const r = validateAuditUrl("http://172.16.0.1");
    expect(r.ok).toBe(false);
  });

  it("rejects AWS metadata endpoint 169.254.169.254", () => {
    const r = validateAuditUrl("http://169.254.169.254");
    expect(r.ok).toBe(false);
  });

  it("rejects IPv6 loopback ::1", () => {
    const r = validateAuditUrl("http://[::1]");
    expect(r.ok).toBe(false);
  });

  // --- Malformed ---
  it("rejects empty string", () => {
    const r = validateAuditUrl("");
    expect(r.ok).toBe(false);
  });

  it("rejects single-label domain (internal hostname)", () => {
    const r = validateAuditUrl("http://internal");
    expect(r.ok).toBe(false);
  });

  it("rejects clearly malformed string", () => {
    const r = validateAuditUrl("not a url at all!!!");
    // Will get prepended with https:// and fail as no-dot domain
    expect(r.ok).toBe(false);
  });
});

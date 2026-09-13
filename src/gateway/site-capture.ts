/**
 * Server-side public-site capture — SSRF-safe, bounded, runtime-neutral (Node only: uses
 * `node:dns/promises` for DNS-rebinding protection, so this cannot run on an Edge runtime).
 *
 * Shared by:
 *   - the Vite dev middleware (src/gateway/vite-plugin.ts), loaded via server.ssrLoadModule
 *   - the Vercel production handler (api/site-capture.ts), imported directly
 * so capture behaviour — the exact same SSRF checks, redirect handling, page budget and priority
 * crawl — is identical in local dev and production. Never import this from browser code.
 */
import { lookup } from "node:dns/promises";
import { digestPage, discoveredSameSiteLinks, pickCrawlLinks, type SiteCapture } from "@/services/site-digest";

export const MAX_PAGES = 6;
export const MAX_HTML_BYTES = 1_500_000;
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// SSRF protection — fail-closed. Hostname rules first, then every resolved address.
// ---------------------------------------------------------------------------

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::" || v === "::1") return true;
  if (/^::ffff:(\d+\.\d+\.\d+\.\d+)$/.test(v)) return isPrivateIPv4(v.replace(/^::ffff:/, ""));
  return /^(fc|fd|fe[89ab])/.test(v);
}

export function hostnameBlocked(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "Invalid URL"; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return `Protocol not allowed: ${parsed.protocol}`;
  if (parsed.username || parsed.password) return "Credentials in URL are not allowed";
  const h = parsed.hostname.toLowerCase();
  if (!h) return "Missing hostname";
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return "Loopback/internal hostnames are not allowed";
  if (h.startsWith("[")) return isPrivateIPv6(h) ? "Private IPv6 addresses are not allowed" : null;
  if (/^\d+$/.test(h) || /^0x/i.test(h) || /^\d+\.\d+\.\d+\.\d+$/.test(h) === false && /^[\d.]+$/.test(h)) return "Numeric hostnames are not allowed";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateIPv4(h) ? "Private network addresses are not allowed" : null;
  if (h === "metadata.google.internal" || h === "169.254.169.254") return "Metadata endpoint addresses are not allowed";
  if (!h.includes(".")) return "Single-label hostnames are not allowed";
  return null;
}

/** Resolve every address for the hostname; block if ANY is private (DNS rebinding / split-horizon). */
async function resolvedBlocked(url: string): Promise<string | null> {
  const h = new URL(url).hostname.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[")) return null; // literal already checked
  try {
    const addrs = await lookup(h, { all: true });
    if (!addrs.length) return "Hostname did not resolve";
    for (const a of addrs) {
      if (a.family === 4 && isPrivateIPv4(a.address)) return `Hostname resolves to a private address (${a.address})`;
      if (a.family === 6 && isPrivateIPv6(a.address)) return `Hostname resolves to a private address (${a.address})`;
    }
    return null;
  } catch {
    return "Hostname could not be resolved";
  }
}

export async function ssrfCheck(url: string): Promise<string | null> {
  return hostnameBlocked(url) ?? (await resolvedBlocked(url));
}

/** Manual redirect following so every hop is re-validated and bounded. No cookies, no auth. */
export async function fetchPublic(url: string): Promise<{ finalUrl: string; status: number; html: string } | { error: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const blocked = await ssrfCheck(current);
    if (blocked) return { error: hop === 0 ? blocked : `Redirect target blocked: ${blocked}` };
    let res: Response;
    try {
      res = await fetch(current, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "CT-OS-Audit/1.0 (public website analysis; contact@creativetouch.co.za)", Accept: "text/html,application/xhtml+xml" },
        redirect: "manual",
        credentials: "omit",
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { error: `Redirect (${res.status}) without location` };
      try { current = new URL(loc, current).toString(); } catch { return { error: "Invalid redirect location" }; }
      continue;
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(type) && type) return { error: `Not an HTML page (${type.split(";")[0]})` };
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_HTML_BYTES) return { error: `Response too large (${declared} bytes)` };
    const reader = res.body?.getReader();
    if (!reader) return { finalUrl: current, status: res.status, html: "" };
    const decoder = new TextDecoder();
    let html = "";
    let total = 0;
    while (total < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      html += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => undefined);
    return { finalUrl: current, status: res.status, html };
  }
  return { error: `Too many redirects (>${MAX_REDIRECTS})` };
}

export type SiteCaptureResponse = { ok: true; capture: SiteCapture } | { ok: false; error: string } | { ok: false; reason: string; blocked: true };

/** Full capture: homepage + up to `maxPages - 1` intent-prioritised same-domain pages. */
export async function captureSite(url: string, maxPages: number = MAX_PAGES): Promise<SiteCaptureResponse> {
  const blocked = await ssrfCheck(url);
  if (blocked) return { ok: false, reason: blocked, blocked: true };
  const capturedAt = new Date().toISOString();
  const home = await fetchPublic(url);
  if ("error" in home) return { ok: false, error: home.error };
  if (home.status >= 400) return { ok: false, error: `Homepage returned HTTP ${home.status}` };
  const homeDigest = digestPage(home.finalUrl, home.html, home.status);
  const pages = [homeDigest];
  const skippedUrls: Array<{ url: string; reason: string }> = [];
  const discoveredUrls = discoveredSameSiteLinks(homeDigest).map((l) => l.href);
  for (const link of pickCrawlLinks(homeDigest, Math.max(0, maxPages - 1))) {
    const r = await fetchPublic(link);
    if ("error" in r) { skippedUrls.push({ url: link, reason: r.error }); continue; }
    if (r.status >= 400) { skippedUrls.push({ url: link, reason: `HTTP ${r.status}` }); continue; }
    pages.push(digestPage(r.finalUrl, r.html, r.status));
  }
  return { ok: true, capture: { targetUrl: home.finalUrl, capturedAt, pages, skippedUrls, screenshots: [], discoveredUrls } };
}

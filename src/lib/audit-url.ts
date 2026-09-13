/**
 * SSRF-safe URL validation for website audits.
 *
 * Fails closed: anything not explicitly allowed is rejected.
 * Never allow localhost, private RFC1918 ranges, metadata endpoints, file://, ftp://, etc.
 */

export type UrlValidationResult =
  | { ok: true; normalised: string }
  | { ok: false; reason: string };

// IPv4 private ranges and loopback
const BLOCKED_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,  // link-local (AWS metadata reachable from 169.254.169.254)
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,             // IPv6 loopback
  /^\[?fc[0-9a-f]{2}:/i,    // IPv6 ULA
  /^\[?fe80:/i,              // IPv6 link-local
];

// Cloud metadata endpoints (partial)
const METADATA_HOSTS = [
  "169.254.169.254",   // AWS/GCP/Azure IMDS
  "metadata.google.internal",
  "169.254.170.2",     // ECS task metadata
];

function isPrivateHost(host: string): boolean {
  // Strip IPv6 brackets: [::1] -> ::1
  const stripped = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  // For non-IPv6, strip port suffix
  const h = stripped.includes(":") && !stripped.startsWith(":") && !stripped.includes("::") ? stripped.split(":")[0] : stripped;
  if (METADATA_HOSTS.some((m) => h === m)) return true;
  if (h === "::1" || stripped === "::1") return true;
  return BLOCKED_PATTERNS.some((p) => p.test(h));
}

export function validateAuditUrl(raw: string): UrlValidationResult {
  if (!raw || typeof raw !== "string") {
    return { ok: false, reason: "URL is required." };
  }

  const trimmed = raw.trim();

  // Reject obviously non-http schemes before URL parsing
  if (/^(file|ftp|javascript|data|vbscript|about):/i.test(trimmed)) {
    return { ok: false, reason: "Only http:// and https:// URLs are allowed." };
  }

  // Add scheme if missing (assume https)
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, reason: "The URL is malformed and could not be parsed." };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "Only http:// and https:// URLs are allowed." };
  }

  const host = parsed.hostname;

  if (!host || host.length === 0) {
    return { ok: false, reason: "URL must include a valid domain." };
  }

  // Reject bare TLDs and single-label domains (e.g. "http://internal")
  if (!host.includes(".") && !host.startsWith("[")) {
    return { ok: false, reason: "URL must include a valid public domain (e.g. example.com)." };
  }

  if (isPrivateHost(host)) {
    return {
      ok: false,
      reason: "Auditing private/internal network addresses is not permitted.",
    };
  }

  // Normalise: drop trailing slash, lowercase scheme+host
  const normalised =
    parsed.protocol.toLowerCase() +
    "//" +
    parsed.host.toLowerCase() +
    parsed.pathname.replace(/\/$/, "") +
    parsed.search +
    parsed.hash;

  return { ok: true, normalised: normalised || withScheme };
}

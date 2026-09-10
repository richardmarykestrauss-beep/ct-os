/**
 * Deterministic QA foundation (CTOS-005A Final Pass).
 *
 * Three concrete checks:
 *   A. Placeholder / test content detection
 *   B. Link classification (no network calls — fixture / markup input only)
 *   C. Console error evidence typing
 *
 * All functions are pure; no network, no DOM access.
 */

// ---------------------------------------------------------------------------
// A. Placeholder content detection
// ---------------------------------------------------------------------------

export type PlaceholderKind =
  | "lorem_ipsum"
  | "todo_comment"
  | "fixme_comment"
  | "placeholder_text"
  | "test_email"
  | "example_email"
  | "dummy_phone"
  | "hash_navigation";

export interface PlaceholderEvidence {
  kind: PlaceholderKind;
  /** The matched substring. */
  match: string;
  /** Up to 60 chars of surrounding text for context. */
  context: string;
}

const PLACEHOLDER_PATTERNS: Array<{ kind: PlaceholderKind; pattern: RegExp }> = [
  { kind: "lorem_ipsum", pattern: /lorem\s+ipsum/i },
  { kind: "todo_comment", pattern: /\bTODO\b/ },
  { kind: "fixme_comment", pattern: /\bFIXME\b/ },
  { kind: "placeholder_text", pattern: /\bplaceholder\b/i },
  { kind: "test_email", pattern: /\btest@test\.[a-z]{2,}\b/i },
  { kind: "example_email", pattern: /\b[\w.+-]+@example\.(?:com|org|net|co)\b/i },
  {
    kind: "dummy_phone",
    pattern: /\b(?:\(?555\)?[-.\s]?\d{3,4}(?:[-.\s]?\d{4})?|0{7,}|1{7,}|(?:\+1[-.\s]?)?555[-.\s]?0{3}[-.\s]?\d{4})\b/,
  },
  { kind: "hash_navigation", pattern: /href\s*=\s*["']#["']/i },
];

/**
 * Scan text for placeholder / test content.
 * Returns one evidence record per match — multiple matches of the same kind are all reported.
 * Conservative: returns evidence rather than a boolean so callers can judge context.
 */
export function detectPlaceholderContent(text: string): PlaceholderEvidence[] {
  const results: PlaceholderEvidence[] = [];
  for (const { kind, pattern } of PLACEHOLDER_PATTERNS) {
    const globalPat = new RegExp(pattern.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = globalPat.exec(text)) !== null) {
      const start = Math.max(0, m.index - 30);
      const end = Math.min(text.length, m.index + m[0].length + 30);
      results.push({
        kind,
        match: m[0],
        context: text.slice(start, end).replace(/\s+/g, " ").trim(),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// B. Link classification (no network calls)
// ---------------------------------------------------------------------------

export type LinkClassification =
  | "valid_internal"       // starts with / and matches a known page
  | "unresolved_internal"  // starts with / but not in knownPages
  | "fragment_only"        // "#" or "#anchor"
  | "external"             // http(s) or protocol-relative (//)
  | "malformed";           // unparseable or empty

export interface LinkInput {
  url: string;
  text?: string;
}

export interface LinkCheckResult {
  url: string;
  classification: LinkClassification;
  text?: string;
}

/**
 * Classify a single URL against a list of known page paths.
 * knownPages should be absolute paths starting with "/" (e.g. ["/about", "/shop"]).
 * No network calls are made.
 */
export function classifyLink(url: string, knownPages: string[]): LinkClassification {
  if (!url || typeof url !== "string") return "malformed";
  const trimmed = url.trim();
  if (trimmed === "") return "malformed";
  if (trimmed === "#" || (trimmed.startsWith("#") && !trimmed.startsWith("#!"))) return "fragment_only";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("//")) return "external";
  if (trimmed.startsWith("mailto:") || trimmed.startsWith("tel:") || trimmed.startsWith("javascript:")) return "external";
  if (trimmed.startsWith("/")) {
    const path = trimmed.split("?")[0]!.split("#")[0]!;
    return knownPages.includes(path) ? "valid_internal" : "unresolved_internal";
  }
  // Relative (no leading slash) — treat as malformed; internal links should be absolute paths
  return "malformed";
}

/** Classify a batch of links. */
export function checkLinks(links: LinkInput[], knownPages: string[]): LinkCheckResult[] {
  return links.map((link) => ({
    url: link.url,
    ...(link.text !== undefined ? { text: link.text } : {}),
    classification: classifyLink(link.url, knownPages),
  }));
}

// ---------------------------------------------------------------------------
// C. Console error evidence
// ---------------------------------------------------------------------------

export type ConsoleErrorKind = "error" | "warning" | "info";

/**
 * Typed record of a single browser console entry.
 * Agent 06 must NOT claim "console checked" without an array of these records as evidence —
 * an empty array means console was clean, not that it was unchecked.
 */
export interface ConsoleErrorRecord {
  kind: ConsoleErrorKind;
  message: string;
  source?: string;
  lineNumber?: number;
}

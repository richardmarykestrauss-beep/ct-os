/**
 * Site digest — turns captured public HTML into compact, structured evidence.
 *
 * Raw HTML never becomes an artifact or reaches a provider: a digest is what the audit agents read.
 * That keeps prompts small, keeps third-party markup/JS out of the model context, and makes every
 * claim traceable to an observable field (h1, navLinks, ctaTexts, ...). Pure functions only.
 */

export interface PageDigest {
  url: string;
  statusCode: number | null;
  title: string;
  metaDescription: string | null;
  h1: string[];
  h2: string[];
  navLinks: Array<{ text: string; href: string }>;
  ctaTexts: string[];
  formCount: number;
  imageCount: number;
  imagesWithoutAlt: number;
  externalScriptHosts: string[];
  hasAnalytics: boolean;
  contactSignals: string[];
  wordCount: number;
  textExcerpt: string;
}

export interface SiteCapture {
  targetUrl: string;
  capturedAt: string;
  pages: PageDigest[];
  skippedUrls: Array<{ url: string; reason: string }>;
  /** Screenshot evidence refs. Empty = VISUAL_NOT_VERIFIED for A03. */
  screenshots: string[];
  /** Same-domain pages seen on the homepage (captured or not) — drives coverage disclosure. */
  discoveredUrls?: string[];
}

export interface CaptureCoverage {
  pagesCaptured: number;
  pagesDiscovered: number;
  pagesSkipped: number;
  /** Discovered but not captured (budget or failure). */
  notCaptured: string[];
  partial: boolean;
}

export function captureCoverage(capture: SiteCapture): CaptureCoverage {
  const captured = new Set(capture.pages.map((p) => p.url.replace(/\/$/, "")));
  const discovered = Array.from(new Set([...(capture.discoveredUrls ?? []), ...capture.skippedUrls.map((s) => s.url)].map((u) => u.replace(/\/$/, ""))));
  const notCaptured = discovered.filter((u) => !captured.has(u));
  const pagesDiscovered = discovered.length + 1; // + homepage
  return { pagesCaptured: capture.pages.length, pagesDiscovered, pagesSkipped: capture.skippedUrls.length, notCaptured, partial: notCaptured.length > 0 };
}

const LIMITS = { h1: 10, h2: 15, navLinks: 25, ctaTexts: 12, scriptHosts: 20, contactSignals: 10, excerptChars: 700 };

const ANALYTICS_PATTERNS = [/googletagmanager\.com/i, /google-analytics\.com/i, /gtag\(/i, /fbq\(/i, /connect\.facebook\.net/i, /hotjar/i, /_hjSettings/i, /clarity\.ms/i, /plausible\.io/i, /matomo/i];
const CTA_PATTERNS = [/get (a )?quote/i, /contact us/i, /book (now|a call|online)/i, /call (us|now)/i, /get started/i, /enquire/i, /request/i, /buy now/i, /add to cart/i, /shop now/i, /sign up/i, /subscribe/i, /learn more/i, /download/i, /apply/i];

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "));
}

function all(re: RegExp, html: string, max: number, map: (m: RegExpExecArray) => string | null): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  while ((m = g.exec(html)) && out.length < max) {
    const v = map(m);
    if (v) out.push(v);
  }
  return out;
}

function hostOf(src: string): string | null {
  try {
    return new URL(src).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Resolve an href against the page URL; null for non-http, mailto/tel/js, or unparsable. */
export function resolveHref(href: string, base: string): string | null {
  const h = href.trim();
  if (!h || /^(#|javascript:|mailto:|tel:|data:)/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function digestPage(url: string, html: string, statusCode: number | null): PageDigest {
  const head = html.slice(0, 200_000);
  const body = head.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "");
  const metaMatch = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(head) ?? /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(head);
  const metaDescription = metaMatch ? decodeEntities(metaMatch[1]) || null : null;
  const h1 = all(/<h1[^>]*>([\s\S]*?)<\/h1>/i, body, LIMITS.h1, (m) => stripTags(m[1]) || null);
  const h2 = all(/<h2[^>]*>([\s\S]*?)<\/h2>/i, body, LIMITS.h2, (m) => stripTags(m[1]) || null);
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const navLinks: Array<{ text: string; href: string }> = [];
  const ctaTexts: string[] = [];
  const seenHref = new Set<string>();
  let am: RegExpExecArray | null;
  while ((am = anchorRe.exec(body))) {
    const text = stripTags(am[2]).slice(0, 80);
    const attrs = am[0];
    if (text && CTA_PATTERNS.some((p) => p.test(text)) && ctaTexts.length < LIMITS.ctaTexts && !ctaTexts.includes(text)) ctaTexts.push(text);
    else if (/class=["'][^"']*\bbtn\b|button/i.test(attrs) && text && ctaTexts.length < LIMITS.ctaTexts && !ctaTexts.includes(text)) ctaTexts.push(text);
    const resolved = resolveHref(am[1], url);
    if (!resolved || !text || seenHref.has(resolved) || navLinks.length >= LIMITS.navLinks) continue;
    seenHref.add(resolved);
    navLinks.push({ text, href: resolved });
  }
  for (const b of all(/<button[^>]*>([\s\S]*?)<\/button>/i, body, LIMITS.ctaTexts, (m) => stripTags(m[1]) || null)) {
    if (ctaTexts.length < LIMITS.ctaTexts && !ctaTexts.includes(b)) ctaTexts.push(b.slice(0, 80));
  }
  const formCount = (body.match(/<form\b/gi) ?? []).length;
  const imgTags = body.match(/<img\b[^>]*>/gi) ?? [];
  const imagesWithoutAlt = imgTags.filter((t) => !/\balt=["'][^"']+["']/i.test(t)).length;
  const scriptHosts = Array.from(new Set(all(/<script[^>]+src=["']([^"']+)["']/i, head, 200, (m) => hostOf(m[1])))).slice(0, LIMITS.scriptHosts);
  const hasAnalytics = ANALYTICS_PATTERNS.some((p) => p.test(head));
  const contactSignals: string[] = [];
  if (/href=["']tel:/i.test(body)) contactSignals.push("tel: link");
  if (/href=["']mailto:/i.test(body)) contactSignals.push("mailto: link");
  if (/\+\d[\d\s\-()]{7,}\d/.test(stripTags(body))) contactSignals.push("phone number in text");
  if (/whatsapp|wa\.me/i.test(body)) contactSignals.push("WhatsApp link");
  if (formCount > 0) contactSignals.push(`${formCount} form(s)`);
  if (/testimonial|review|trustpilot|rating/i.test(body)) contactSignals.push("testimonial/review markup");
  const text = stripTags(body.replace(/<\/(p|div|li|h[1-6]|section|article|footer|header|nav)>/gi, ". "));
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
  return {
    url,
    statusCode,
    title,
    metaDescription,
    h1,
    h2,
    navLinks,
    ctaTexts,
    formCount,
    imageCount: imgTags.length,
    imagesWithoutAlt,
    externalScriptHosts: scriptHosts,
    hasAnalytics,
    contactSignals: contactSignals.slice(0, LIMITS.contactSignals),
    wordCount,
    textExcerpt: text.slice(0, LIMITS.excerptChars),
  };
}

/**
 * Intent weighting for same-domain pages discovered on the homepage. Commercial/decision pages
 * (what they sell, how to buy, who they are, how to reach them) outrank supporting pages, which
 * outrank legal/account pages. Unknown pages sit between MEDIUM and LOW.
 */
export type CrawlIntent = "HIGH" | "MEDIUM" | "UNKNOWN" | "LOW";

const INTENT_RULES: Array<{ intent: CrawlIntent; re: RegExp }> = [
  { intent: "LOW", re: /privacy|terms|conditions|legal|cookie|disclaimer|login|log-in|sign-?in|account|register|cart|checkout|wishlist|sitemap/i },
  { intent: "HIGH", re: /service|product|shop|store|catalog|how-to-order|how to order|ordering|order-?process|about|our-company|our company|who-we-are|company|pric|plans|packages|contact|get-in-touch|enquir|quote/i },
  { intent: "MEDIUM", re: /project|portfolio|our-work|case-stud|gallery|faq|help|support|deliver|shipping|industr|sector|solution|team|testimonial|review|blog|news|resources/i },
];

const INTENT_SCORE: Record<CrawlIntent, number> = { HIGH: 3, MEDIUM: 2, UNKNOWN: 1, LOW: 0 };

export function crawlIntent(link: { text: string; href: string }): CrawlIntent {
  let path = link.href;
  try {
    path = decodeURIComponent(new URL(link.href).pathname);
  } catch {
    /* keep raw href */
  }
  const probe = `${path} ${link.text}`;
  // LOW is checked first so "terms-of-service" never scores as a service page.
  for (const r of INTENT_RULES) if (r.re.test(probe)) return r.intent;
  return "UNKNOWN";
}

/** Same-domain, non-asset, non-homepage links discovered on the homepage (deduped, in nav order). */
export function discoveredSameSiteLinks(homepage: PageDigest): Array<{ text: string; href: string }> {
  let home: URL;
  try {
    home = new URL(homepage.url);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  return homepage.navLinks.filter((l) => {
    try {
      const u = new URL(l.href);
      const key = u.toString().replace(/\/$/, "");
      if (u.hostname.toLowerCase() !== home.hostname.toLowerCase()) return false;
      if (key === home.toString().replace(/\/$/, "")) return false;
      if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|mp4|webp|docx?|xlsx?)$/i.test(u.pathname)) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    } catch {
      return false;
    }
  });
}

/** Pages worth reading after the homepage: highest intent first, nav order as tie-break, bounded by `max`. */
export function pickCrawlLinks(homepage: PageDigest, max = 5): string[] {
  return discoveredSameSiteLinks(homepage)
    .map((l, index) => ({ href: l.href, score: INTENT_SCORE[crawlIntent(l)], index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, max))
    .map((l) => l.href);
}

/** Deterministic heuristic checks over the digest — supporting evidence only, always labelled. */
export function heuristicSignals(page: PageDigest): Array<{ key: string; observed: string }> {
  const out: Array<{ key: string; observed: string }> = [];
  if (!page.h1.length) out.push({ key: "no_h1", observed: "No <h1> element found." });
  if (!page.metaDescription || page.metaDescription.length < 20) out.push({ key: "meta_description", observed: "Meta description missing or under 20 characters." });
  if (!page.ctaTexts.length) out.push({ key: "no_cta", observed: "No call-to-action link or button text detected." });
  if (!page.hasAnalytics) out.push({ key: "no_analytics", observed: "No common analytics script detected (GTM/GA4/Pixel/Hotjar/Clarity/Plausible/Matomo)." });
  if (!page.contactSignals.some((s) => /tel|mailto|phone|whatsapp|form/i.test(s))) out.push({ key: "no_contact", observed: "No phone, email, WhatsApp or form signal detected." });
  if (!page.contactSignals.some((s) => /testimonial/i.test(s))) out.push({ key: "no_social_proof", observed: "No testimonial/review markup detected." });
  if (page.imageCount > 0 && page.imagesWithoutAlt / page.imageCount > 0.5) out.push({ key: "alt_text", observed: `${page.imagesWithoutAlt} of ${page.imageCount} images have no alt text.` });
  if (page.url.startsWith("http://")) out.push({ key: "no_https", observed: "Page served over http, not https." });
  return out;
}

/**
 * CTOS-007A: website audit pure services — request lifecycle, digests, heuristics, normalisation, synthesis.
 * No live HTTP, no providers. Fixture HTML only.
 */
import { describe, expect, it } from "vitest";
import { EMPTY } from "@/gateway/core";
import { applyQaVerdicts, auditCompletion, consolidateFindings, createAuditRequest, heuristicFindings, isAuditJob, normaliseAgentFindings, qaVerdictsOf, synthesiseAuditReport, updateAuditRequest } from "@/services/website-audit";
import { captureCoverage, crawlIntent, digestPage, heuristicSignals, pickCrawlLinks, type SiteCapture } from "@/services/site-digest";
import type { AuditFinding } from "@/data/types";
import { validateOutput } from "@/schemas/artifacts";

// ---------------------------------------------------------------------------
// createAuditRequest / updateAuditRequest
// ---------------------------------------------------------------------------

describe("createAuditRequest", () => {
  it("creates a PENDING request for a valid URL with the caller's id", () => {
    const r = createAuditRequest(EMPTY, { id: "audit_1", targetUrl: "https://example.com", auditType: "PUBLIC_PROSPECT" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.id).toBe("audit_1");
    expect(r.request.status).toBe("PENDING");
    expect(r.request.auditJobIds).toEqual([]);
    expect(r.request.reviewedAt).toBeNull();
    expect(r.data.websiteAuditRequests).toHaveLength(1);
  });

  it("normalises the URL (adds https if missing)", () => {
    const r = createAuditRequest(EMPTY, { targetUrl: "example.com", auditType: "PUBLIC_PROSPECT" });
    expect(r.ok && r.request.targetUrl).toMatch(/^https:\/\//);
  });

  it("rejects localhost and private IPs (fail closed)", () => {
    expect(createAuditRequest(EMPTY, { targetUrl: "http://localhost", auditType: "PUBLIC_PROSPECT" }).ok).toBe(false);
    expect(createAuditRequest(EMPTY, { targetUrl: "http://192.168.1.1", auditType: "PUBLIC_PROSPECT" }).ok).toBe(false);
    expect(createAuditRequest(EMPTY, { targetUrl: "http://169.254.169.254/latest", auditType: "PUBLIC_PROSPECT" }).ok).toBe(false);
    expect(createAuditRequest(EMPTY, { targetUrl: "file:///etc/passwd", auditType: "PUBLIC_PROSPECT" }).ok).toBe(false);
  });

  it("adds no project tickets and no jobs (production pipeline untouched)", () => {
    const r = createAuditRequest(EMPTY, { targetUrl: "https://example.com", auditType: "PUBLIC_PROSPECT" });
    expect(r.ok && r.data.tickets).toHaveLength(0);
    expect(r.ok && r.data.agentJobs).toHaveLength(0);
  });
});

describe("updateAuditRequest", () => {
  it("updates status, job ids, reviewedAt and appends to progressLog", () => {
    const base = createAuditRequest(EMPTY, { id: "a", targetUrl: "https://example.com", auditType: "PUBLIC_PROSPECT" });
    if (!base.ok) throw new Error("setup failed");
    const updated = updateAuditRequest(base.data, "a", { status: "CAPTURING", progressMessage: "Fetching…", auditJobIds: ["j1"], reviewedAt: "2026-01-01T00:00:00Z" });
    const req = updated.websiteAuditRequests[0];
    expect(req.status).toBe("CAPTURING");
    expect(req.progressLog).toContain("Fetching…");
    expect(req.auditJobIds).toEqual(["j1"]);
    expect(req.reviewedAt).toBe("2026-01-01T00:00:00Z");
    expect(isAuditJob(updated, { id: "j1" })).toBe(true);
    expect(isAuditJob(updated, { id: "j1", ticketId: "t1" })).toBe(false);
  });

  it("no-ops on unknown request id", () => {
    expect(updateAuditRequest(EMPTY, "nonexistent", { status: "FAILED" }).websiteAuditRequests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Digest — fixture HTML
// ---------------------------------------------------------------------------

const FULL_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Example Business</title>
  <meta name="description" content="We make widgets for industry professionals everywhere." />
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXX"></script>
</head>
<body>
  <nav><a href="/about">About us</a><a href="/services">Services</a><a href="/contact">Contact</a><a href="https://other.example.org/x">Partner</a></nav>
  <h1>Premium Widgets for Professionals</h1>
  <h2>Our services</h2>
  <a href="https://example.com/quote" class="btn btn-primary">Get a Quote</a>
  <img src="a.jpg" alt="Widget"><img src="b.jpg">
  <section class="testimonials"><blockquote>Great product!</blockquote></section>
  <form action="/enquire"><input name="email"></form>
  <footer><a href="tel:+27123456789">+27 12 345 6789</a><a href="mailto:info@example.com">Email Us</a></footer>
  <script>alert("never in digest")</script>
</body>
</html>`.trim();

const MINIMAL_HTML = `<!DOCTYPE html><html><head><title>Sparse Site</title></head><body><p>Welcome to our site.</p></body></html>`;

describe("digestPage", () => {
  it("extracts structured evidence and never carries raw HTML/JS", () => {
    const d = digestPage("https://example.com", FULL_HTML, 200);
    expect(d.title).toBe("Example Business");
    expect(d.metaDescription).toMatch(/widgets/);
    expect(d.h1).toEqual(["Premium Widgets for Professionals"]);
    expect(d.h2).toEqual(["Our services"]);
    expect(d.navLinks.map((l) => l.href)).toContain("https://example.com/about");
    expect(d.ctaTexts).toContain("Get a Quote");
    expect(d.formCount).toBe(1);
    expect(d.imageCount).toBe(2);
    expect(d.imagesWithoutAlt).toBe(1);
    expect(d.hasAnalytics).toBe(true);
    expect(d.externalScriptHosts).toContain("www.googletagmanager.com");
    expect(d.contactSignals.join(" ")).toMatch(/tel: link/);
    expect(JSON.stringify(d)).not.toMatch(/alert\(|<script|<h1/);
  });

  it("picks same-domain priority pages only, bounded", () => {
    const d = digestPage("https://example.com", FULL_HTML, 200);
    const links = pickCrawlLinks(d, 2);
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.startsWith("https://example.com/"))).toBe(true);
    expect(links.join(" ")).not.toMatch(/other\.example\.org/);
  });

  it("crawls commercial/decision pages first and legal/account pages last within the page budget", () => {
    // SO-CA-shaped nav: legal and login appear early in nav order, commercial pages later.
    const nav = `<nav>
      <a href="/terms-and-conditions">Terms and Conditions</a>
      <a href="/privacy-policy">Privacy</a>
      <a href="/login">Login</a>
      <a href="/blog">Blog</a>
      <a href="/our-company">Our Company</a>
      <a href="/how-to-order">How to Order</a>
      <a href="/contact-us">Contact Us</a>
      <a href="https://portal.other-host.example/order">ORDER ONLINE</a>
    </nav>`;
    const d = digestPage("https://so-ca.example", `<html><head><title>x</title></head><body>${nav}<h1>Hi</h1></body></html>`, 200);
    expect(crawlIntent({ text: "Terms and Conditions", href: "https://so-ca.example/terms-of-service" })).toBe("LOW");
    expect(crawlIntent({ text: "How to Order", href: "https://so-ca.example/how-to-order" })).toBe("HIGH");
    expect(crawlIntent({ text: "Blog", href: "https://so-ca.example/blog" })).toBe("MEDIUM");
    const picked = pickCrawlLinks(d, 4);
    expect(picked).toEqual(["https://so-ca.example/our-company", "https://so-ca.example/how-to-order", "https://so-ca.example/contact-us", "https://so-ca.example/blog"]);
    expect(picked.join(" ")).not.toMatch(/terms|privacy|login|other-host/);
    // With a tighter budget legal pages are never reached
    expect(pickCrawlLinks(d, 3).some((l) => /terms|privacy|login/.test(l))).toBe(false);
    // Coverage disclosure knows every discovered page, captured or not
    const cov = captureCoverage({ targetUrl: d.url, capturedAt: "", pages: [d, digestPage(picked[0], "<html><title>c</title></html>", 200)], skippedUrls: [{ url: picked[1], reason: "HTTP 500" }], screenshots: [], discoveredUrls: d.navLinks.filter((l) => l.href.startsWith("https://so-ca.example/")).map((l) => l.href) });
    expect(cov).toMatchObject({ pagesCaptured: 2, pagesDiscovered: 8, pagesSkipped: 1, partial: true });
    expect(cov.notCaptured).toContain("https://so-ca.example/how-to-order");
  });

  it("flags heuristic signals on a sparse page and none of them on a full page", () => {
    const sparse = heuristicSignals(digestPage("http://example.com", MINIMAL_HTML, 200)).map((s) => s.key);
    expect(sparse).toEqual(expect.arrayContaining(["no_h1", "meta_description", "no_cta", "no_analytics", "no_contact", "no_social_proof", "no_https"]));
    const full = heuristicSignals(digestPage("https://example.com", FULL_HTML, 200)).map((s) => s.key);
    expect(full).not.toContain("no_h1");
    expect(full).not.toContain("no_analytics");
    expect(full).not.toContain("no_https");
  });
});

const capture = (url: string, html: string): SiteCapture => ({ targetUrl: url, capturedAt: "2026-01-01T00:00:00.000Z", pages: [digestPage(url, html, 200)], skippedUrls: [], screenshots: [] });

describe("heuristicFindings", () => {
  it("are labelled HEURISTIC, carry agentId null, and validate as audit_capture input", () => {
    const c = capture("http://example.com", MINIMAL_HTML);
    expect(validateOutput("audit_capture@1", c).ok).toBe(true);
    const f = heuristicFindings(c, "req_x", null);
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x) => x.agentId === null && /HEURISTIC/.test(x.evidence) && x.auditRequestId === "req_x")).toBe(true);
    expect(f.find((x) => x.category === "TECHNICAL")?.severity).toBe("CRITICAL");
  });

  it("returns nothing for an empty capture", () => {
    expect(heuristicFindings({ targetUrl: "https://x.com", capturedAt: "", pages: [], skippedUrls: [], screenshots: [] }, "r", null)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Normalisation, QA verdicts, synthesis
// ---------------------------------------------------------------------------

const goodFinding = { id: "ux-nav", category: "UX", severity: "MAJOR", claimType: "OBSERVED", title: "Navigation lacks hierarchy", detail: "Flat nav.", evidence: "navLinks: About, Services, Contact", businessImpact: null, affectedUrl: null, estimatedEffort: "2h", recommendation: "Group links", serviceOpportunity: null };
const ctx = { agentId: "agent_02", requestId: "req", projectId: "p1", targetUrl: "https://example.com" };

describe("normaliseAgentFindings", () => {
  it("normalises valid findings and REJECTS malformed ones instead of repairing them", () => {
    const n = normaliseAgentFindings("audit_architecture", { uxFindings: [goodFinding, { id: "bad", category: "NOPE", severity: "MAJOR", claimType: "OBSERVED", title: "x", detail: "y", evidence: "z" }, { id: "bad2", severity: "MAJOR" }] }, ctx);
    expect(n.findings).toHaveLength(1);
    expect(n.rejected).toHaveLength(2);
    expect(n.findings[0].agentId).toBe("agent_02");
    expect(n.findings[0].affectedUrl).toBe("https://example.com");
    expect(n.idMap["ux-nav"]).toBe(n.findings[0].id);
  });

  it("reads the phase-specific field and ignores unknown artifact types", () => {
    expect(normaliseAgentFindings("audit_content_analysis", { contentFindings: [goodFinding] }, ctx).findings).toHaveLength(1);
    expect(normaliseAgentFindings("audit_discovery", { summary: "x" }, ctx).findings).toHaveLength(0);
  });

  it("A03 cannot mark VISUAL findings VERIFIED without screenshots", () => {
    const n = normaliseAgentFindings("audit_creative", { creativeFindings: [{ ...goodFinding, category: "VISUAL", claimType: "VERIFIED" }] }, { ...ctx, agentId: "agent_03" });
    expect(n.findings[0].claimType).toBe("INFERRED");
  });
});

describe("applyQaVerdicts", () => {
  it("drops REJECTED, downgrades CHALLENGED, annotates CONFIRMED", () => {
    const a = normaliseAgentFindings("audit_architecture", { uxFindings: [goodFinding, { ...goodFinding, id: "ux-2", title: "Second finding" }, { ...goodFinding, id: "ux-3", title: "Third" }] }, ctx);
    const verdicts = qaVerdictsOf({ challengedFindings: [{ findingId: "ux-nav", verdict: "REJECTED", reason: "contradicted" }, { findingId: "ux-2", verdict: "CHALLENGED", reason: "overstated" }, { findingId: "ux-3", verdict: "CONFIRMED", reason: "seen" }, { findingId: "nope", verdict: "BAD" }] });
    expect(verdicts).toHaveLength(3);
    const r = applyQaVerdicts(a.findings, verdicts, a.idMap);
    expect(r.rejectedCount).toBe(1);
    expect(r.challengedCount).toBe(1);
    expect(r.findings).toHaveLength(2);
    expect(r.findings.find((f) => f.title === "Second finding")?.claimType).toBe("INFERRED");
    expect(r.findings.find((f) => f.title === "Third")?.detail).toMatch(/QA confirmed/);
  });
});

describe("consolidateFindings", () => {
  const raw = (over: Partial<AuditFinding>): AuditFinding => ({ id: over.id ?? `r_${Math.random().toString(36).slice(2, 8)}`, auditRequestId: "req", projectId: null, agentId: "agent_02", category: "SEO", severity: "MINOR", claimType: "OBSERVED", title: "Images missing alt text", detail: "Several images have no alt attribute.", evidence: "imagesWithoutAlt: 6", businessImpact: null, affectedUrl: "https://x.com", estimatedEffort: null, recommendation: null, serviceOpportunity: null, createdAt: null, ...over });

  it("merges the same root issue from A02/A03/A04 + heuristic into one canonical finding with full provenance", () => {
    const a02 = raw({ id: "a02-alt", agentId: "agent_02", severity: "MINOR", recommendation: "Add alt text.", qaStatus: "CONFIRMED" });
    const a03 = raw({ id: "a03-alt", agentId: "agent_03", category: "VISUAL", severity: "MAJOR", title: "Image alt attributes absent", detail: "Hero and product images lack alt text.", evidence: "hero img has no alt", businessImpact: "Accessibility and image search suffer across the catalogue.", affectedUrl: "https://x.com/products", qaStatus: "CONFIRMED" });
    const a04 = raw({ id: "a04-alt", agentId: "agent_04", category: "SEO", title: "Missing alt text on images", claimType: "INFERRED", recommendation: "Write descriptive alt text for product images.", qaStatus: "UNREVIEWED" });
    const heur = raw({ id: "h-alt", agentId: null, title: "Most images lack alt text", evidence: "4 of 6 images have no alt text. (HEURISTIC)" });
    const other = raw({ id: "a04-h1", agentId: "agent_04", category: "MESSAGE", title: "No H1 heading on homepage", detail: "The homepage has no h1.", evidence: "h1: []" });
    const r = consolidateFindings([a02, a03, a04, other], [heur], { newId: (p) => `${p}_c${r_n++}` });
    expect(r.raw).toHaveLength(5);
    expect(r.raw.every((f) => f.kind === "RAW")).toBe(true);
    expect(r.consolidated).toHaveLength(2);
    const alt = r.consolidated.find((f) => f.sourceFindingIds?.includes("a02-alt"))!;
    expect(alt.kind).toBe("CONSOLIDATED");
    expect(alt.contributors).toEqual(["agent_02", "agent_03", "agent_04", "heuristic"]);
    expect(alt.sourceFindingIds).toEqual(["a02-alt", "a03-alt", "a04-alt", "h-alt"]);
    expect(alt.severity).toBe("MAJOR"); // highest justified
    expect(alt.claimType).toBe("OBSERVED"); // strongest specialist claim, INFERRED does not drag it down
    expect(alt.businessImpact).toMatch(/catalogue/); // strongest impact statement
    expect(alt.recommendation).toBe("Add alt text. Write descriptive alt text for product images.");
    expect(alt.affectedUrls).toEqual(["https://x.com", "https://x.com/products"]);
    expect(alt.qaStatus).toBe("CONFIRMED");
    expect(alt.evidence).toMatch(/\[A02\].*\[A03\].*\[A04\].*\[Heuristic\] 4 of 6/);
    expect(alt.title).toBe("Image alt attributes absent"); // primary = highest severity specialist
    expect(r.mergedIds.sort()).toEqual(["a02-alt", "a04-alt", "h-alt"].sort()); // everything but the primary
    // the H1 finding is untouched apart from provenance wrapping
    const h1 = r.consolidated.find((f) => f.sourceFindingIds?.includes("a04-h1"))!;
    expect(h1.contributors).toEqual(["agent_04"]);
    expect(h1.title).toBe("No H1 heading on homepage");
  });

  it("a heuristic that duplicates a specialist issue is evidence, one that no agent reported stays a finding", () => {
    const spec = raw({ id: "s-h1", agentId: "agent_04", category: "MESSAGE", title: "Homepage lacks an H1", detail: "No h1 element." });
    const dupHeur = raw({ id: "h-h1", agentId: null, category: "MESSAGE", title: "No H1 heading on homepage", detail: "The homepage has no <h1>." });
    const soloHeur = raw({ id: "h-https", agentId: null, category: "TECHNICAL", severity: "CRITICAL", title: "Site is not served over HTTPS", detail: "Captured over http." });
    const r = consolidateFindings([spec], [dupHeur, soloHeur]);
    expect(r.consolidated).toHaveLength(2);
    const h1 = r.consolidated.find((f) => f.sourceFindingIds?.includes("s-h1"))!;
    expect(h1.contributors).toEqual(["agent_04", "heuristic"]);
    expect(h1.agentId).toBe("agent_04");
    const https = r.consolidated.find((f) => f.sourceFindingIds?.includes("h-https"))!;
    expect(https.contributors).toEqual(["heuristic"]);
    expect(https.agentId).toBeNull();
    expect(https.severity).toBe("CRITICAL");
  });

  it("A06 verdicts flow through: rejected removed before consolidation, challenged retained as INFERRED, QA meta-notes never become client defects", () => {
    const n = normaliseAgentFindings("audit_architecture", { uxFindings: [goodFinding, { ...goodFinding, id: "ux-2", title: "Checkout flow is broken", detail: "Assumed from nav." }, { ...goodFinding, id: "ux-3", title: "Contact details hard to find" }] }, ctx);
    const v = qaVerdictsOf({ challengedFindings: [{ findingId: "ux-2", verdict: "REJECTED", reason: "checkout never tested" }, { findingId: "ux-3", verdict: "CHALLENGED", reason: "tel: link exists in footer" }, { findingId: "ux-nav", verdict: "CONFIRMED", reason: "seen" }] });
    const q = applyQaVerdicts(n.findings, v, n.idMap);
    const qaNote = raw({ id: "qa-dup", agentId: "agent_06", category: "OTHER", title: "Duplicate observations across agents", detail: "Alt text was reported by A02, A03 and A04 — same root issue.", qaStatus: "UNREVIEWED" });
    const qaReal = raw({ id: "qa-real", agentId: "agent_06", category: "TECHNICAL", title: "About page returns HTTP 404", detail: "skippedUrls lists /about with HTTP 404.", qaStatus: "UNREVIEWED" });
    const r = consolidateFindings([...q.findings, qaNote, qaReal], []);
    const titles = r.consolidated.map((f) => f.title);
    expect(titles).not.toContain("Checkout flow is broken");
    expect(titles).not.toContain("Duplicate observations across agents");
    expect(titles).toContain("About page returns HTTP 404");
    expect(r.qaNoteIds).toEqual(["qa-dup"]);
    expect(r.raw.some((f) => f.id === "qa-dup")).toBe(true); // kept internally
    const challenged = r.consolidated.find((f) => f.title === "Contact details hard to find")!;
    expect(challenged.claimType).toBe("INFERRED");
    expect(challenged.qaStatus).toBe("CHALLENGED");
    expect(r.consolidated.find((f) => f.title === goodFinding.title)?.qaStatus).toBe("CONFIRMED");
  });

  it("partial coverage never leaves a VERIFIED site-wide claim standing", () => {
    const f = raw({ id: "v", claimType: "VERIFIED", title: "Navigation is consistent site-wide", category: "UX" });
    expect(consolidateFindings([f], [], { partialCoverage: true }).consolidated[0].claimType).toBe("OBSERVED");
    expect(consolidateFindings([f], [], { partialCoverage: false }).consolidated[0].claimType).toBe("VERIFIED");
  });
});
let r_n = 0;

describe("synthesiseAuditReport", () => {
  const request = createAuditRequest(EMPTY, { id: "req", targetUrl: "https://example.com", auditType: "PUBLIC_PROSPECT" });
  const req = request.ok ? request.request : (() => { throw new Error("setup"); })();
  const outcomes = (statuses: Array<"COMPLETED" | "FAILED">) => statuses.map((s, i) => ({ agentId: `agent_0${i + 1}`, jobId: `j${i}`, status: s, providerId: s === "COMPLETED" ? "claude" : null, model: null, artifactId: null }));

  it("produces a valid website_audit_report@1 that only re-uses normalised findings", () => {
    const c = capture("https://example.com", FULL_HTML);
    const n = normaliseAgentFindings("audit_architecture", { uxFindings: [goodFinding] }, ctx);
    const h = heuristicFindings(c, "req", null);
    const r = synthesiseAuditReport({ request: req, capture: c, findings: n.findings, heuristics: h, outcomes: outcomes(["COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED"]), qaSummary: "ok", qaQualityScore: 8, rejectedCount: 0, challengedCount: 0, discoverySummary: "A service business." });
    expect(r.completion).toBe("COMPLETE");
    expect(validateOutput("website_audit_report@1", r.content).ok).toBe(true);
    const reported = r.content.findings as Array<{ id: string; agentId: string | null }>;
    expect(reported.map((f) => f.id)).toEqual([n.findings[0].id, ...h.map((x) => x.id)]);
    expect(r.content.visualVerificationStatus).toBe("VISUAL_NOT_VERIFIED");
    expect((r.content.evidenceGaps as string[]).join(" ")).toMatch(/No screenshots/);
    expect(r.content.heuristicFindingIds).toEqual(h.map((x) => x.id));
  });

  it("reports the CONSOLIDATED count as the headline, the raw count and coverage alongside", () => {
    // Two of three images without alt → the alt-text heuristic fires and must merge into A02's alt finding.
    const c: SiteCapture = { ...capture("https://example.com", FULL_HTML.replace('<img src="b.jpg">', '<img src="b.jpg"><img src="c.jpg">')), discoveredUrls: ["https://example.com/about", "https://example.com/services", "https://example.com/contact"] };
    const n = normaliseAgentFindings("audit_architecture", { uxFindings: [goodFinding, { ...goodFinding, id: "ux-alt", category: "SEO", title: "Images missing alt text", detail: "Alt attributes absent.", evidence: "imagesWithoutAlt: 1" }] }, ctx);
    const h = heuristicFindings(c, "req", null); // includes the alt-text heuristic → merges
    const merged = consolidateFindings(n.findings, h, { partialCoverage: true });
    const r = synthesiseAuditReport({ request: req, capture: c, findings: merged.consolidated, heuristics: [], rawFindings: merged.raw, outcomes: outcomes(["COMPLETED", "COMPLETED"]), qaSummary: null, qaQualityScore: null, rejectedCount: 0, challengedCount: 0, discoverySummary: null });
    expect(validateOutput("website_audit_report@1", r.content).ok).toBe(true);
    expect(r.content.rawFindingCount).toBe(merged.raw.length);
    expect(r.content.consolidatedFindingCount).toBe(merged.consolidated.length);
    expect((r.content.findings as unknown[]).length).toBe(merged.consolidated.length);
    expect(merged.raw.length).toBeGreaterThan(merged.consolidated.length);
    expect(r.summary).toMatch(new RegExp(`${merged.consolidated.length} finding\\(s\\).*Consolidated from ${merged.raw.length} raw`));
    expect(r.content.coverage).toMatchObject({ pagesCaptured: 1, pagesDiscovered: 4, pagesSkipped: 0, partial: true });
    expect((r.content.evidenceGaps as string[])[0]).toMatch(/Partial coverage: 1 of 4/);
    expect(r.summary).toMatch(/partial — not site-wide/);
    const alt = (r.content.findings as Array<{ title: string; contributors?: string[] }>).find((f) => /alt/i.test(f.title))!;
    expect(alt.contributors).toEqual(["agent_02", "heuristic"]);
  });

  it("completion maps: all → COMPLETE, some → PARTIAL, none → HEURISTIC_ONLY / NEEDS_A_HAND", () => {
    expect(auditCompletion(outcomes(["COMPLETED", "COMPLETED"]))).toEqual({ completion: "COMPLETE", status: "COMPLETE" });
    expect(auditCompletion(outcomes(["COMPLETED", "FAILED"]))).toEqual({ completion: "PARTIAL", status: "PARTIAL" });
    expect(auditCompletion(outcomes(["FAILED", "FAILED"]))).toEqual({ completion: "HEURISTIC_ONLY", status: "NEEDS_A_HAND" });
  });
});

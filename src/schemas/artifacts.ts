/**
 * Versioned structured-output schemas for artifacts (Zod).
 *
 * A provider response only becomes an artifact if it validates against the schema named by the
 * job's `requiredOutputSchema` ("<artifact_type>@<version>"). Schemas are deliberately modest:
 * enough structure to be useful downstream, not so much that models fail on formatting.
 *
 * Every entry exposes an `example` — the deterministic output the stub providers return, and a
 * fixture for tests. Examples are validated at module load so a drifting schema fails fast.
 */
import { z } from "zod";
import type { ArtifactType, ValidationResult } from "@/data/types";

const nonEmpty = z.string().min(1);
const shortList = z.array(nonEmpty).max(50);

const evidenceRef = z.object({
  ref: nonEmpty.describe("Ticket code, artifact id, URL or QA item id"),
  note: z.string().optional(),
});

const severity = z.enum(["P0", "P1", "P2", "P3"]);

// Shared by the CTOS-004A benchmark report schemas below: one discrete, evidence-backed
// observation, always carrying its own confidence so "confidence per finding" is a property
// of the finding itself rather than a separate list that has to stay in sync by hand.
const findingItem = z.object({
  id: nonEmpty.describe("Short stable slug, e.g. \"ux-nav-depth\""),
  finding: nonEmpty,
  evidence: nonEmpty.describe("What was actually observed - a URL, a rendered page detail, a specific element"),
  confidence: z.number().min(0).max(1),
});

const benchmarkReportShape = {
  businessUnderstanding: nonEmpty,
  audienceInferred: shortList,
  conversionModelInferred: nonEmpty,
  siteStrengths: z.array(findingItem).max(30),
  uxWeaknesses: z.array(findingItem).max(50),
  visualWeaknesses: z.array(findingItem).max(50),
  seoContentWeaknesses: z.array(findingItem).max(50),
  technicalFindings: z.array(findingItem).max(50),
  recommendedImplementationPlan: z.array(z.object({ step: nonEmpty, rationale: nonEmpty, priority: severity })).min(1).max(50),
  confidenceSummary: z.array(z.object({ findingId: nonEmpty, confidence: z.number().min(0).max(1), rationale: nonEmpty })).max(150),
  unsupportedAssumptionsRejected: shortList.describe("Assumptions Agent 06 QA explicitly challenged and struck, with why"),
  humanReviewQuestions: shortList,
  evidenceLog: z.array(evidenceRef).max(50),
};

export const SCHEMAS = {
  "project_brief@1": z.object({
    goal: nonEmpty,
    scope: shortList,
    constraints: shortList,
    successCriteria: shortList,
    summary: nonEmpty,
  }),
  "research_report@1": z.object({
    summary: nonEmpty.describe("Plain-language summary a client could read"),
    businessContext: shortList,
    existingSiteFindings: shortList,
    competitorInsights: shortList,
    risks: shortList,
    recommendations: shortList,
    sources: z.array(evidenceRef).max(50),
  }),
  "site_blueprint@1": z.object({
    summary: nonEmpty,
    sitemap: z.array(z.object({ title: nonEmpty, path: nonEmpty, purpose: nonEmpty, children: z.array(z.object({ title: nonEmpty, path: nonEmpty })).max(50).default([]) })).min(1).max(100),
    journeys: z.array(z.object({ name: nonEmpty, steps: shortList, conversionGoal: nonEmpty })).max(20),
    conversionLogic: shortList,
    openQuestions: shortList,
  }),
  "design_system@1": z.object({
    summary: nonEmpty,
    direction: nonEmpty,
    palette: z.array(z.object({ token: nonEmpty, value: nonEmpty, usage: nonEmpty })).max(40),
    typography: z.array(z.object({ token: nonEmpty, family: nonEmpty, usage: nonEmpty })).max(20),
    spacingScale: z.array(z.string()).max(20),
    components: shortList,
    imageryDirection: shortList,
  }),
  "content_pack@1": z.object({
    summary: nonEmpty,
    seoArchitecture: shortList,
    pages: z.array(z.object({ path: nonEmpty, title: nonEmpty, metaDescription: nonEmpty, h1: nonEmpty, sections: shortList })).min(1).max(100),
    internalLinking: shortList,
  }),
  "build_plan@1": z.object({
    summary: nonEmpty,
    tickets: z.array(z.object({ title: nonEmpty, objective: nonEmpty, scope: shortList, doNotChange: shortList, permissionLevel: z.enum(["GREEN", "AMBER", "RED"]) })).min(1).max(100),
    risks: shortList,
  }),
  "build_report@1": z.object({
    summary: nonEmpty,
    built: z.array(z.object({ item: nonEmpty, reference: z.string().optional(), verified: z.boolean() })).max(200),
    warnings: shortList,
    notVerified: shortList,
  }),
  "qa_report@1": z.object({
    summary: nonEmpty,
    result: z.enum(["PASS", "ISSUES_FOUND", "FAIL", "INCOMPLETE"]),
    defects: z.array(z.object({ title: nonEmpty, severity, category: nonEmpty, evidence: nonEmpty, page: z.string().optional() })).max(500),
    counts: z.object({ P0: z.number().int().min(0), P1: z.number().int().min(0), P2: z.number().int().min(0), P3: z.number().int().min(0) }),
    readyForHumanReview: z.boolean(),
  }),
  "client_feedback@1": z.object({
    summary: nonEmpty,
    items: z.array(z.object({ page: z.string().optional(), feedback: nonEmpty, sentiment: z.enum(["positive", "neutral", "negative"]), actionRequired: z.boolean() })).max(200),
  }),
  "deployment_report@1": z.object({
    summary: nonEmpty,
    backupVerified: z.boolean(),
    steps: z.array(z.object({ step: nonEmpty, outcome: z.enum(["done", "skipped", "failed"]), note: z.string().optional() })).max(100),
    rollbackAvailable: z.boolean(),
    warnings: shortList,
  }),
  "lesson_candidate@1": z.object({
    summary: nonEmpty,
    lessons: z
      .array(
        z.object({
          title: nonEmpty,
          content: nonEmpty,
          category: z.enum(["safety", "qa", "build", "wordpress", "elementor", "design", "content", "conversion", "client", "process", "performance", "other"]),
          evidence: z.array(nonEmpty).min(1).max(20),
          confidence: z.number().min(0).max(1),
          proposedScope: z.enum(["AGENCY", "PROJECT"]),
        }),
      )
      .min(1)
      .max(20),
  }),
  // CTOS-004A Part Q: agent_benchmark_report@1 is the U-Proof "known" run (agents have normal
  // access to existing CT-OS project knowledge/artifacts for U-Proof); blind_benchmark_report@1
  // is the Imvusa run, which must NOT draw on U-Proof or any cross-project knowledge - only
  // APPROVED Creative Touch doctrine. Both share benchmarkReportShape so cross-site comparison
  // is apples-to-apples; agent_benchmark_report@1 adds knownContextUsed to make what carried
  // over from prior project knowledge explicit and auditable.
  "agent_benchmark_report@1": z.object({
    ...benchmarkReportShape,
    knownContextUsed: shortList.describe("Existing CT-OS project knowledge/artifacts legitimately drawn on for this non-blind run"),
  }),
  "blind_benchmark_report@1": z.object(benchmarkReportShape),
  "cross_site_agent_evaluation@1": z.object({
    summary: nonEmpty,
    dimensions: z
      .array(
        z.object({
          dimension: z.enum([
            "independent_discovery_quality",
            "generic_vs_site_specific",
            "hallucinations",
            "implementation_specificity",
            "visual_reasoning_quality",
            "seo_reasoning_quality",
            "qa_challenge_quality",
          ]),
          uProofAssessment: nonEmpty,
          imvusaAssessment: nonEmpty,
          verdict: nonEmpty,
        }),
      )
      .length(7),
    trustRecommendation: z.object({
      verdict: z.enum(["TRUST", "TRUST_WITH_CONDITIONS", "DO_NOT_TRUST_YET"]),
      rationale: nonEmpty,
      conditions: shortList,
    }),
    overallFindings: shortList,
  }),
  "other@1": z.object({ summary: nonEmpty, content: z.unknown().optional() }),
} as const;

export type SchemaName = keyof typeof SCHEMAS;

export const EXAMPLES: Record<SchemaName, unknown> = {
  "project_brief@1": { goal: "Rebuild the site on a portable stack", scope: ["Pages", "Templates"], constraints: ["No DNS changes"], successCriteria: ["Launch approved"], summary: "Stub project brief." },
  "research_report@1": {
    summary: "Stub research summary.",
    businessContext: ["Waterproofing products supplier"],
    existingSiteFindings: ["Existing site present"],
    competitorInsights: ["Competitors lead with solution pages"],
    risks: ["Missing product data"],
    recommendations: ["Structure the catalogue by application"],
    sources: [{ ref: "art_up_brief", note: "Project brief" }],
  },
  "site_blueprint@1": {
    summary: "Stub blueprint.",
    sitemap: [{ title: "Home", path: "/", purpose: "Orient and route", children: [{ title: "Solutions", path: "/solutions" }] }],
    journeys: [{ name: "Quote request", steps: ["Home", "Solution", "Contact"], conversionGoal: "Quote form submitted" }],
    conversionLogic: ["Primary CTA: request a quote"],
    openQuestions: [],
  },
  "design_system@1": {
    summary: "Stub design system.",
    direction: "Clean, industrial, trustworthy",
    palette: [{ token: "primary", value: "#0B3D91", usage: "CTAs" }],
    typography: [{ token: "heading", family: "Inter", usage: "H1–H3" }],
    spacingScale: ["4", "8", "16", "24", "32"],
    components: ["Button", "Card"],
    imageryDirection: ["Application photography"],
  },
  "content_pack@1": {
    summary: "Stub content pack.",
    seoArchitecture: ["Solution pages target application keywords"],
    pages: [{ path: "/", title: "Home", metaDescription: "Waterproofing products and solutions.", h1: "Waterproofing that lasts", sections: ["Hero", "Solutions", "Why us"] }],
    internalLinking: ["Home → Solutions"],
  },
  "build_plan@1": {
    summary: "Stub build plan.",
    tickets: [{ title: "Header", objective: "Build the header template", scope: ["Header"], doNotChange: ["Live site"], permissionLevel: "AMBER" }],
    risks: [],
  },
  "build_report@1": { summary: "Stub build report.", built: [{ item: "Header template", reference: "Template 292", verified: false }], warnings: [], notVerified: ["Visual QA pending"] },
  "qa_report@1": { summary: "Stub QA report.", result: "INCOMPLETE", defects: [], counts: { P0: 0, P1: 0, P2: 0, P3: 0 }, readyForHumanReview: false },
  "client_feedback@1": { summary: "Stub client feedback.", items: [{ feedback: "Looks good", sentiment: "positive", actionRequired: false }] },
  "deployment_report@1": { summary: "Stub deployment report.", backupVerified: false, steps: [{ step: "Backup", outcome: "skipped", note: "Stub" }], rollbackAvailable: false, warnings: ["Stub — nothing deployed"] },
  "lesson_candidate@1": {
    summary: "Stub lesson candidates.",
    lessons: [{ title: "Browser rendering beats HTTP-200 checks", content: "An HTTP 200 proves the page served, not that it rendered.", category: "qa", evidence: ["CT-UP-019"], confidence: 0.6, proposedScope: "AGENCY" }],
  },
  "agent_benchmark_report@1": {
    businessUnderstanding: "Stub: waterproofing products supplier selling direct and via trade.",
    audienceInferred: ["Trade buyers", "DIY homeowners"],
    conversionModelInferred: "Stub: add to cart / request a quote",
    siteStrengths: [{ id: "product-range", finding: "Broad, clearly categorised product range", evidence: "Shop page category list", confidence: 0.8 }],
    uxWeaknesses: [{ id: "nav-depth", finding: "Some solution pages are 3+ clicks from home", evidence: "Sitemap crawl", confidence: 0.6 }],
    visualWeaknesses: [{ id: "hero-contrast", finding: "Low text/background contrast on the hero", evidence: "Rendered homepage screenshot", confidence: 0.7 }],
    seoContentWeaknesses: [{ id: "meta-missing", finding: "Missing meta description on the shop page", evidence: "Page <head> inspection", confidence: 0.9 }],
    technicalFindings: [{ id: "no-shipping", finding: "No shipping zones configured at checkout", evidence: "Test order flow", confidence: 0.9 }],
    recommendedImplementationPlan: [{ step: "Configure shipping zones", rationale: "Checkout currently accepts orders with no shipping cost", priority: "P0" }],
    confidenceSummary: [{ findingId: "no-shipping", confidence: 0.9, rationale: "Directly reproduced via a test order" }],
    unsupportedAssumptionsRejected: ["Assumed Payflex was live - QA found no configured gateway"],
    humanReviewQuestions: ["Which shipping carriers/rates should be configured?"],
    evidenceLog: [{ ref: "https://example.invalid/shop", note: "Live shop page fetch" }],
    knownContextUsed: ["Prior CT-OS U-Proof project audits and tickets"],
  },
  "blind_benchmark_report@1": {
    businessUnderstanding: "Stub: furniture retailer.",
    audienceInferred: ["Homeowners furnishing a new space"],
    conversionModelInferred: "Stub: enquiry form / call to action",
    siteStrengths: [{ id: "product-photography", finding: "Clear product photography", evidence: "Homepage gallery", confidence: 0.7 }],
    uxWeaknesses: [{ id: "no-search", finding: "No visible product search", evidence: "Header inspection", confidence: 0.6 }],
    visualWeaknesses: [{ id: "inconsistent-spacing", finding: "Inconsistent section spacing", evidence: "Rendered page screenshots", confidence: 0.5 }],
    seoContentWeaknesses: [{ id: "thin-copy", finding: "Thin product descriptions", evidence: "Product page content", confidence: 0.6 }],
    technicalFindings: [{ id: "no-https-redirect", finding: "HTTP does not redirect to HTTPS", evidence: "Direct request", confidence: 0.8 }],
    recommendedImplementationPlan: [{ step: "Force HTTPS redirect", rationale: "Mixed-protocol access is a trust and SEO risk", priority: "P1" }],
    confidenceSummary: [{ findingId: "no-https-redirect", confidence: 0.8, rationale: "Reproduced with a direct unauthenticated request" }],
    unsupportedAssumptionsRejected: ["Assumed a physical showroom exists - no address found on the site"],
    humanReviewQuestions: ["Is there a physical showroom, and should the site say so?"],
    evidenceLog: [{ ref: "https://example.invalid/", note: "Live homepage fetch" }],
  },
  "cross_site_agent_evaluation@1": {
    summary: "Stub cross-site evaluation.",
    dimensions: [
      { dimension: "independent_discovery_quality", uProofAssessment: "Stub", imvusaAssessment: "Stub", verdict: "Stub" },
      { dimension: "generic_vs_site_specific", uProofAssessment: "Stub", imvusaAssessment: "Stub", verdict: "Stub" },
      { dimension: "hallucinations", uProofAssessment: "Stub", imvusaAssessment: "Stub", verdict: "Stub" },
      { dimension: "implementation_specificity", uProofAssessment: "Stub", imvusaAssessment: "Stub", verdict: "Stub" },
      { dimension: "visual_reasoning_quality", uProofAssessment: "Stub", imvusaAssessment: "Stub", verdict: "Stub" },
      { dimension: "seo_reasoning_quality", uProofAssessment: "Stub", imvusaAssessment: "Stub", verdict: "Stub" },
      { dimension: "qa_challenge_quality", uProofAssessment: "Stub", imvusaAssessment: "Stub", verdict: "Stub" },
    ],
    trustRecommendation: { verdict: "TRUST_WITH_CONDITIONS", rationale: "Stub.", conditions: ["Stub condition"] },
    overallFindings: ["Stub finding"],
  },
  "other@1": { summary: "Stub output." },
};

export function isSchemaName(name: string): name is SchemaName {
  return Object.prototype.hasOwnProperty.call(SCHEMAS, name);
}

export function parseSchemaName(name: string): { type: ArtifactType; version: number } {
  const [type, v] = name.split("@");
  return { type: type as ArtifactType, version: Number(v ?? 1) || 1 };
}

/** Validate provider output against a named schema. Never throws; unknown schema is a failure. */
export function validateOutput(schemaName: string, output: unknown): ValidationResult & { value?: unknown } {
  if (!isSchemaName(schemaName)) return { ok: false, schema: schemaName, issues: [{ path: "", message: `Unknown output schema "${schemaName}"` }] };
  const parsed = SCHEMAS[schemaName].safeParse(output);
  if (parsed.success) return { ok: true, schema: schemaName, issues: [], value: parsed.data };
  return {
    ok: false,
    schema: schemaName,
    issues: parsed.error.issues.slice(0, 25).map((i) => ({ path: i.path.map(String).join(".") || "(root)", message: i.message })),
  };
}

/** JSON Schema for providers that accept a response schema (OpenAI structured outputs, etc.). */
export function jsonSchemaFor(schemaName: SchemaName): Record<string, unknown> {
  return z.toJSONSchema(SCHEMAS[schemaName], { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
}

export function exampleFor(schemaName: string): unknown {
  return isSchemaName(schemaName) ? structuredClone(EXAMPLES[schemaName]) : { summary: "Stub output.", schema: schemaName };
}

// Fail fast if an example drifts from its schema.
for (const name of Object.keys(SCHEMAS) as SchemaName[]) {
  const r = SCHEMAS[name].safeParse(EXAMPLES[name]);
  if (!r.success) throw new Error(`Schema example for ${name} does not validate: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
}

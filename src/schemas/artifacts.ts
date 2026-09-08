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

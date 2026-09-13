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
  /**
   * build_pack@1 — the single authoritative build contract (CTOS-005A Part 5).
   * The build-pack assembler FAILS CLOSED on conflicts; Agent 05 consumes this only.
   * Conflict records are included so a human can see exactly what blocked assembly.
   */
  "build_pack@1": z.object({
    summary: nonEmpty,
    projectId: nonEmpty,
    version: z.number().int().min(1),
    siteBlueprintArtifactId: nonEmpty.nullable(),
    designSystemArtifactId: nonEmpty.nullable(),
    contentPackArtifactId: nonEmpty.nullable(),
    pages: z.array(z.object({
      path: nonEmpty,
      title: nonEmpty,
      templateType: nonEmpty,
      sectionRequirements: shortList,
      contentMappings: z.record(z.string(), z.string()),
      responsiveRequirements: shortList,
      seoMeta: z.object({ title: nonEmpty, metaDescription: nonEmpty, h1: nonEmpty }),
      assetRefs: z.array(z.string()).max(50),
    })).min(1).max(200),
    constraints: shortList,
    permissions: z.array(z.enum(["GREEN", "AMBER", "RED"])).max(3),
    acceptanceCriteria: shortList,
    evidenceRequirements: shortList,
    /** Non-empty → status is CONFLICT; human attention required before Builder proceeds. */
    conflicts: z.array(z.object({
      kind: z.enum([
        "section_missing_from_blueprint",
        "content_field_unresolvable",
        "cross_project_artifact",
        "design_contradicts_constraint",
        "section_dependency_unavailable",
        "missing_required_content",
      ]),
      detail: nonEmpty,
      artifactIds: z.array(z.string()).max(10),
    })).max(50),
  }),

  /**
   * job_pack@1 — first-class renderable execution contract (CTOS-005A Part 7).
   * Transportable through API, Claude subscription, ChatGPT, Gemini, Hermes, or human.
   * MUST be secret-clean before export — secretScanStatus must be "clean".
   */
  "job_pack@1": z.object({
    summary: nonEmpty,
    jobId: nonEmpty,
    projectId: nonEmpty,
    ticketId: nonEmpty.nullable(),
    agentCode: nonEmpty,
    agentCharter: nonEmpty,
    neverOwns: shortList,
    operatingPass: z.enum(["DIRECTION", "COMPOSITION", "VISUAL_REVIEW"]).nullable(),
    skillId: nonEmpty.nullable(),
    skillVersion: z.number().int().min(1).nullable(),
    projectBriefCard: nonEmpty,
    inputArtifacts: z.array(z.object({
      id: nonEmpty,
      type: nonEmpty,
      version: z.number().int().min(1),
      title: nonEmpty,
      summary: nonEmpty.nullable(),
      originalContentChars: z.number().int().min(0).nullable(),
    })).max(20),
    approvedLessons: z.array(z.object({
      id: nonEmpty,
      title: nonEmpty,
      content: nonEmpty,
      scope: z.enum(["DOCTRINE", "AGENCY", "PROJECT", "TASK"]),
    })).max(20),
    constraints: shortList,
    permissions: z.array(z.enum(["GREEN", "AMBER", "RED"])).max(3),
    task: nonEmpty,
    outputSchema: nonEmpty,
    validationRequirements: shortList,
    evidenceExpectations: shortList,
    secretScanStatus: z.enum(["clean", "flagged"]),
    secretScanIssues: z.array(z.string()).max(20),
  }),

  /**
   * design_direction@1 — Agent 03 DIRECTION pass output (CTOS-005B Part 1).
   * Brand/direction analysis: tone, colour strategy, typography strategy, signature element,
   * reference modes, and explicit anti-generic decisions.
   */
  "design_direction@1": z.object({
    summary: nonEmpty,
    brandDirection: nonEmpty.describe("Plain-language brand direction a client could read"),
    visualTone: nonEmpty,
    colorStrategy: nonEmpty,
    typographyStrategy: nonEmpty,
    signatureElement: nonEmpty.describe("Description of the proposed signature visual element"),
    references: z.array(z.object({ url: nonEmpty, title: nonEmpty, mode: z.enum(["REPLICATE", "MODERNIZE", "REIMAGINE"]) })).max(20),
    antiGenericDecisions: z.array(z.object({ patternChallenged: nonEmpty, chosenApproach: nonEmpty })).max(20),
    evidenceLog: z.array(evidenceRef).max(50),
  }),

  /**
   * page_composition@1 — Agent 03 COMPOSITION pass output (CTOS-005B Part 1).
   * Page-by-page layout composition and section requirements.
   */
  "page_composition@1": z.object({
    summary: nonEmpty,
    designSystemArtifactId: nonEmpty.nullable(),
    pages: z.array(z.object({
      path: nonEmpty,
      compositionRationale: nonEmpty,
      sections: z.array(z.object({
        name: nonEmpty,
        layoutDescription: nonEmpty,
        contentBrief: nonEmpty,
        designNotes: z.string().optional(),
      })).min(1).max(50),
    })).min(1).max(100),
  }),

  /**
   * visual_review@1 — Agent 03 VISUAL_REVIEW pass OR Agent 06 QA visual output (CTOS-005B Part 1/21).
   * 18-dimension rubric result; overall verdict; never averaged over critical dimensions.
   */
  "visual_review@1": z.object({
    summary: nonEmpty,
    operatingPass: z.enum(["DIRECTION", "COMPOSITION", "VISUAL_REVIEW"]),
    overallVerdict: z.enum(["A", "B", "C"]),
    scores: z.array(z.object({
      dimension: z.enum([
        "BRAND_ALIGNMENT", "VISUAL_HIERARCHY", "LAYOUT_COMPOSITION", "SPACING_RHYTHM",
        "TYPOGRAPHY", "COLOR_USE", "IMAGERY", "NAVIGATION", "CTA_CLARITY", "CONVERSION_CLARITY",
        "TRUST", "CONTENT_CLARITY", "RESPONSIVENESS", "MOBILE_USABILITY", "PRODUCT_PRESENTATION",
        "ORIGINALITY", "POLISH", "TECHNICAL_VISUAL_DEFECTS",
      ]),
      score: z.number().int().min(1).max(5),
      verdict: z.enum(["A", "B", "C"]),
      rationale: nonEmpty,
      evidence: z.array(nonEmpty).max(10),
    })).min(1).max(18),
    criticalDimensions: z.array(nonEmpty).max(18),
    blockingIssues: shortList,
    screenshotEvidenceIds: z.array(z.string()).max(50),
  }),

  /**
   * elementor_build_manifest@1 — Agent 05 Builder output (CTOS-005B Parts 9/10).
   * Records what was built, what strategy was used per section, and human-edit protection hashes.
   */
  "elementor_build_manifest@1": z.object({
    summary: nonEmpty,
    projectId: nonEmpty,
    version: z.number().int().min(1),
    designTokenSetId: nonEmpty.nullable(),
    pages: z.array(z.object({
      path: nonEmpty,
      title: nonEmpty,
      sections: z.array(z.object({
        id: nonEmpty,
        name: nonEmpty,
        strategy: z.enum(["LIBRARY_ASSEMBLY", "NATIVE_NOVEL_BUILD"]),
        libraryEntryId: z.string().nullable(),
        noveltyJustification: z.string().nullable(),
      })).max(50),
      humanEditProtection: z.object({
        contentHash: nonEmpty.nullable(),
        lastBuiltByJobId: nonEmpty.nullable(),
        artifactVersion: z.number().int().min(1).nullable(),
        humanEditDetected: z.boolean(),
      }),
    })).min(1).max(200),
    buildStrategyDecisions: z.array(z.object({
      sectionId: nonEmpty,
      strategy: z.enum(["LIBRARY_ASSEMBLY", "NATIVE_NOVEL_BUILD"]),
      rationale: nonEmpty,
    })).max(200),
    warnings: shortList,
  }),

  "other@1": z.object({ summary: nonEmpty, content: z.unknown().optional() }),

  // CTOS-007: Website Audit Engine
  // Capture evidence — digests only. Raw HTML never enters an artifact or a prompt.
  "audit_capture@1": z.object({
    targetUrl: nonEmpty,
    capturedAt: nonEmpty,
    pages: z.array(z.object({
      url: nonEmpty,
      statusCode: z.number().int().nullable(),
      title: z.string(),
      metaDescription: z.string().nullable(),
      h1: z.array(z.string()).max(10),
      h2: z.array(z.string()).max(15),
      navLinks: z.array(z.object({ text: z.string(), href: z.string() })).max(25),
      ctaTexts: z.array(z.string()).max(12),
      formCount: z.number().int(),
      imageCount: z.number().int(),
      imagesWithoutAlt: z.number().int(),
      externalScriptHosts: z.array(z.string()).max(20),
      hasAnalytics: z.boolean(),
      contactSignals: z.array(z.string()).max(10),
      wordCount: z.number().int(),
      textExcerpt: z.string(),
    })).min(1).max(10),
    skippedUrls: z.array(z.object({ url: nonEmpty, reason: nonEmpty })).max(20),
    screenshots: z.array(nonEmpty).max(20).describe("Screenshot evidence refs. Empty means VISUAL_NOT_VERIFIED."),
    discoveredUrls: z.array(nonEmpty).max(50).optional().describe("Same-domain pages discovered on the homepage, captured or not"),
  }),
  // Intermediate per-agent artifact schemas
  "audit_discovery@1": z.object({
    targetUrl: nonEmpty,
    businessType: nonEmpty.describe("Inferred business type and industry"),
    audienceSignals: shortList.describe("Observable signals about the target audience"),
    primaryGoalSignal: nonEmpty.describe("What the site appears to be trying to achieve"),
    siteStructure: z.array(z.object({ url: nonEmpty, title: nonEmpty, role: nonEmpty })).max(20),
    technicalSignals: shortList.describe("Observable technical signals (CMS, framework, third-party scripts)"),
    summary: nonEmpty,
  }),
  "audit_architecture@1": z.object({
    targetUrl: nonEmpty,
    navigationAssessment: nonEmpty,
    informationArchitecture: nonEmpty,
    uxFindings: z.array(z.object({
      id: nonEmpty,
      category: z.enum(["TRAFFIC", "MESSAGE", "TRUST", "CONVERSION", "FOLLOW_UP", "TECHNICAL", "SEO", "UX", "VISUAL", "OTHER"]),
      severity: z.enum(["CRITICAL", "MAJOR", "MINOR", "COSMETIC"]),
      claimType: z.enum(["OBSERVED", "INFERRED", "PROPOSED", "VERIFIED"]),
      title: nonEmpty,
      detail: nonEmpty,
      evidence: nonEmpty,
      businessImpact: z.string().nullable(),
      affectedUrl: z.string().nullable(),
      estimatedEffort: z.string().nullable(),
      recommendation: z.string().nullable(),
      serviceOpportunity: z.object({ service: nonEmpty, rationale: nonEmpty, estimatedImpact: z.enum(["HIGH", "MEDIUM", "LOW"]) }).nullable(),
    })).max(30),
    summary: nonEmpty,
  }),
  "audit_creative@1": z.object({
    targetUrl: nonEmpty,
    /**
     * VISUAL_NOT_VERIFIED must be set when no screenshots exist. Agent 03 may not claim
     * visual design quality from HTML alone — only structural observations are permitted.
     */
    visualVerificationStatus: z.enum(["VISUAL_NOT_VERIFIED", "VISUAL_VERIFIED"]),
    structuralObservations: shortList.describe("Observable structural/layout signals from HTML only — no visual quality claims"),
    creativeFindings: z.array(z.object({
      id: nonEmpty,
      category: z.enum(["TRAFFIC", "MESSAGE", "TRUST", "CONVERSION", "FOLLOW_UP", "TECHNICAL", "SEO", "UX", "VISUAL", "OTHER"]),
      severity: z.enum(["CRITICAL", "MAJOR", "MINOR", "COSMETIC"]),
      claimType: z.enum(["OBSERVED", "INFERRED", "PROPOSED", "VERIFIED"]),
      title: nonEmpty,
      detail: nonEmpty,
      evidence: nonEmpty,
      businessImpact: z.string().nullable(),
      affectedUrl: z.string().nullable(),
      estimatedEffort: z.string().nullable(),
      recommendation: z.string().nullable(),
      serviceOpportunity: z.object({ service: nonEmpty, rationale: nonEmpty, estimatedImpact: z.enum(["HIGH", "MEDIUM", "LOW"]) }).nullable(),
    })).max(30),
    summary: nonEmpty,
  }),
  "audit_content_analysis@1": z.object({
    targetUrl: nonEmpty,
    messagingAssessment: nonEmpty,
    seoFindings: shortList,
    contentFindings: z.array(z.object({
      id: nonEmpty,
      category: z.enum(["TRAFFIC", "MESSAGE", "TRUST", "CONVERSION", "FOLLOW_UP", "TECHNICAL", "SEO", "UX", "VISUAL", "OTHER"]),
      severity: z.enum(["CRITICAL", "MAJOR", "MINOR", "COSMETIC"]),
      claimType: z.enum(["OBSERVED", "INFERRED", "PROPOSED", "VERIFIED"]),
      title: nonEmpty,
      detail: nonEmpty,
      evidence: nonEmpty,
      businessImpact: z.string().nullable(),
      affectedUrl: z.string().nullable(),
      estimatedEffort: z.string().nullable(),
      recommendation: z.string().nullable(),
      serviceOpportunity: z.object({ service: nonEmpty, rationale: nonEmpty, estimatedImpact: z.enum(["HIGH", "MEDIUM", "LOW"]) }).nullable(),
    })).max(30),
    summary: nonEmpty,
  }),
  "audit_qa_review@1": z.object({
    targetUrl: nonEmpty,
    challengedFindings: z.array(z.object({
      findingId: nonEmpty,
      verdict: z.enum(["CONFIRMED", "CHALLENGED", "REJECTED"]),
      reason: nonEmpty,
    })).max(50),
    additionalFindings: z.array(z.object({
      id: nonEmpty,
      category: z.enum(["TRAFFIC", "MESSAGE", "TRUST", "CONVERSION", "FOLLOW_UP", "TECHNICAL", "SEO", "UX", "VISUAL", "OTHER"]),
      severity: z.enum(["CRITICAL", "MAJOR", "MINOR", "COSMETIC"]),
      claimType: z.enum(["OBSERVED", "INFERRED", "PROPOSED", "VERIFIED"]),
      title: nonEmpty,
      detail: nonEmpty,
      evidence: nonEmpty,
      businessImpact: z.string().nullable(),
      affectedUrl: z.string().nullable(),
      estimatedEffort: z.string().nullable(),
      recommendation: z.string().nullable(),
      serviceOpportunity: z.object({ service: nonEmpty, rationale: nonEmpty, estimatedImpact: z.enum(["HIGH", "MEDIUM", "LOW"]) }).nullable(),
    })).max(20),
    qualityScore: z.number().int().min(1).max(10).describe("Overall quality/trustworthiness of findings 1–10"),
    summary: nonEmpty,
  }),
  "website_audit_report@1": z.object({
    targetUrl: nonEmpty,
    auditType: z.enum(["PUBLIC_PROSPECT", "CLIENT_DEEP_AUDIT"]),
    summary: nonEmpty,
    /** PARTIAL = providers unavailable for some agents; findings may be incomplete */
    completionStatus: z.enum(["COMPLETE", "PARTIAL", "HEURISTIC_ONLY"]),
    findings: z.array(z.object({
      id: nonEmpty,
      agentId: z.string().nullable(),
      category: z.enum(["TRAFFIC", "MESSAGE", "TRUST", "CONVERSION", "FOLLOW_UP", "TECHNICAL", "SEO", "UX", "VISUAL", "OTHER"]),
      severity: z.enum(["CRITICAL", "MAJOR", "MINOR", "COSMETIC"]),
      claimType: z.enum(["OBSERVED", "INFERRED", "PROPOSED", "VERIFIED"]),
      title: nonEmpty,
      detail: nonEmpty,
      evidence: nonEmpty,
      businessImpact: z.string().nullable(),
      affectedUrl: z.string().nullable(),
      estimatedEffort: z.string().nullable(),
      recommendation: z.string().nullable(),
      serviceOpportunity: z.object({
        service: nonEmpty,
        rationale: nonEmpty,
        estimatedImpact: z.enum(["HIGH", "MEDIUM", "LOW"]),
      }).nullable(),
      contributors: z.array(nonEmpty).max(10).optional(),
      sourceFindingIds: z.array(nonEmpty).max(20).optional(),
      affectedUrls: z.array(nonEmpty).max(20).optional(),
      qaStatus: z.enum(["CONFIRMED", "CHALLENGED", "UNREVIEWED"]).optional(),
    })).max(100),
    serviceOpportunities: z.array(z.object({
      service: nonEmpty,
      rationale: nonEmpty,
      estimatedImpact: z.enum(["HIGH", "MEDIUM", "LOW"]),
    })).max(20),
    humanReviewQuestions: shortList,
    capturedPages: z.array(nonEmpty).max(50),
    capturedAt: nonEmpty,
    // CTOS-007A synthesis fields (optional so pre-007A reports still validate)
    overallVerdict: z.string().optional(),
    topIssues: z.array(nonEmpty).max(10).optional(),
    recommendedActions: z.array(nonEmpty).max(20).optional(),
    evidenceGaps: z.array(nonEmpty).max(20).optional(),
    visualVerificationStatus: z.enum(["VISUAL_NOT_VERIFIED", "VISUAL_VERIFIED"]).optional(),
    agentOutcomes: z.array(z.object({ agentId: nonEmpty, jobId: nonEmpty, status: nonEmpty, providerId: z.string().nullable(), model: z.string().nullable(), artifactId: z.string().nullable() })).max(10).optional(),
    heuristicFindingIds: z.array(nonEmpty).max(50).optional(),
    // CTOS-007A consolidation + coverage (optional so pre-consolidation reports still validate)
    rawFindingCount: z.number().int().optional(),
    consolidatedFindingCount: z.number().int().optional(),
    rawFindings: z.array(z.object({ id: nonEmpty, agentId: z.string().nullable(), category: nonEmpty, severity: nonEmpty, claimType: nonEmpty, title: nonEmpty, evidence: nonEmpty, qaStatus: z.string().optional() })).max(200).optional(),
    coverage: z.object({ pagesCaptured: z.number().int(), pagesDiscovered: z.number().int(), pagesSkipped: z.number().int(), notCaptured: z.array(nonEmpty).max(50), partial: z.boolean() }).optional(),
  }),

  // CTOS-006: WordPress Write Engine schemas (minimal Zod wrappers — full types live in wp-write-engine.ts)
  "website_change_plan@1": z.object({
    id: nonEmpty,
    projectId: nonEmpty,
    siteConnectionId: nonEmpty,
    sourceRequest: nonEmpty,
    targetPageId: nonEmpty,
    targetPageTitle: z.string().nullable(),
    actions: z.array(z.object({
      id: nonEmpty,
      type: nonEmpty,
      permissionLevel: nonEmpty,
      target: z.record(z.string(), z.unknown()),
      preconditions: z.array(z.object({ kind: nonEmpty, expectedValue: nonEmpty })),
      payload: z.record(z.string(), z.unknown()),
      idempotencyKey: nonEmpty,
    })),
    overallPermissionTier: nonEmpty,
    backupRequired: z.boolean(),
    verificationRequired: z.boolean(),
    screenshotRequired: z.boolean(),
    rollbackStrategy: nonEmpty,
    humanApprovalsRequired: z.array(z.string()),
    risks: z.array(z.string()),
    status: nonEmpty,
    approvedById: z.string().nullable(),
    approvedAt: z.string().nullable(),
    executingJobId: z.string().nullable(),
    createdByJobId: z.string().nullable(),
    provenance: nonEmpty,
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  }),
  "wp_write_result@1": z.object({
    id: nonEmpty,
    changePlanId: nonEmpty,
    projectId: nonEmpty,
    siteConnectionId: nonEmpty,
    status: nonEmpty,
    actionResults: z.array(z.object({
      actionId: nonEmpty,
      type: nonEmpty,
      status: nonEmpty,
      beforeValue: z.unknown(),
      afterValue: z.unknown(),
      error: z.string().nullable(),
      verificationPassed: z.boolean().nullable(),
    })),
    beforeSnapshotId: z.string().nullable(),
    afterStateHash: z.string().nullable(),
    verificationResults: z.array(z.object({
      field: nonEmpty,
      expected: z.string(),
      actual: z.string(),
      match: z.boolean(),
    })),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    transport: nonEmpty,
    actorId: z.string().nullable(),
    actorName: z.string().nullable(),
    errors: z.array(z.string()),
    rollbackStatus: z.string().nullable(),
    provenance: nonEmpty,
  }),
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
  "build_pack@1": {
    summary: "Stub build pack — no actual content assembled.",
    projectId: "proj_stub",
    version: 1,
    siteBlueprintArtifactId: null,
    designSystemArtifactId: null,
    contentPackArtifactId: null,
    pages: [
      {
        path: "/",
        title: "Home",
        templateType: "page",
        sectionRequirements: ["Hero", "Services overview", "CTA"],
        contentMappings: { hero_headline: "Welcome", hero_subtext: "Quality you can trust." },
        responsiveRequirements: ["Mobile-first", "Tablet breakpoint at 768px"],
        seoMeta: { title: "Home | Stub Site", metaDescription: "Stub meta description.", h1: "Welcome" },
        assetRefs: [],
      },
    ],
    constraints: ["No custom JS", "Elementor Pro sections only"],
    permissions: ["GREEN"],
    acceptanceCriteria: ["All sections render on mobile and desktop", "No placeholder text"],
    evidenceRequirements: ["Screenshot of each built page at mobile and desktop viewport"],
    conflicts: [],
  },
  "job_pack@1": {
    summary: "Stub job pack.",
    jobId: "job_stub",
    projectId: "proj_stub",
    ticketId: null,
    agentCode: "A01",
    agentCharter: "Agent 01 Discovery — research and surface business context, existing site findings, competitors and risks.",
    neverOwns: ["Gate decisions", "Skill promotion", "Client commitments"],
    operatingPass: null,
    skillId: null,
    skillVersion: null,
    projectBriefCard: "Stub project: a waterproofing products supplier seeking a new website.",
    inputArtifacts: [],
    approvedLessons: [],
    constraints: ["Output must be grounded in observable evidence only"],
    permissions: ["GREEN"],
    task: "Research the client's business, existing site and competitive landscape. Produce a research_report@1 artifact.",
    outputSchema: "research_report@1",
    validationRequirements: ["All sources must be cited in evidenceRef format"],
    evidenceExpectations: ["At least one source per major finding"],
    secretScanStatus: "clean",
    secretScanIssues: [],
  },
  "design_direction@1": {
    summary: "Stub design direction — industrial, trustworthy, purpose-led.",
    brandDirection: "Strong, technical credibility — built for trade buyers who need proof, not persuasion.",
    visualTone: "Clean and purposeful. Industrial confidence without being cold.",
    colorStrategy: "Deep navy primary for authority; amber accent for CTA energy; white space to breathe.",
    typographyStrategy: "Heavy weight for headlines (Inter 700); clear legible body; one type family.",
    signatureElement: "Diagonal cut section divider — references waterproofing membrane layering; no generic curves.",
    references: [{ url: "https://example.invalid/ref1", title: "Industrial B2B reference", mode: "MODERNIZE" }],
    antiGenericDecisions: [{ patternChallenged: "Hero + 3 cards + testimonials layout", chosenApproach: "Application-first navigation: lead with outcome (watertight) not category (products)" }],
    evidenceLog: [{ ref: "art_up_brief", note: "Project brief" }],
  },
  "page_composition@1": {
    summary: "Stub composition — homepage and product archive.",
    designSystemArtifactId: null,
    pages: [{
      path: "/",
      compositionRationale: "Lead with proof of outcome; secondary CTA to application pages.",
      sections: [
        { name: "Hero", layoutDescription: "Full-width; headline left-aligned; application image right", contentBrief: "Primary H1 with outcome statement; CTA to solutions" },
        { name: "Solutions row", layoutDescription: "3-column application cards with icon+title+CTA", contentBrief: "Top 3 waterproofing applications" },
      ],
    }],
  },
  "visual_review@1": {
    summary: "Stub visual review — overall B; two polish items.",
    operatingPass: "VISUAL_REVIEW",
    overallVerdict: "B",
    scores: [
      { dimension: "BRAND_ALIGNMENT", score: 4, verdict: "A", rationale: "Colour and type consistent with brief.", evidence: ["screenshot_desktop_home"] },
      { dimension: "CTA_CLARITY", score: 3, verdict: "B", rationale: "CTA visible but could be more prominent.", evidence: ["screenshot_mobile_home"] },
    ],
    criticalDimensions: [],
    blockingIssues: [],
    screenshotEvidenceIds: ["sse_up_home_1440", "sse_up_home_375"],
  },
  "elementor_build_manifest@1": {
    summary: "Stub build manifest — homepage built.",
    projectId: "proj_stub",
    version: 1,
    designTokenSetId: null,
    pages: [{
      path: "/",
      title: "Home",
      sections: [
        { id: "sec_hero", name: "Hero", strategy: "LIBRARY_ASSEMBLY", libraryEntryId: "slib_hero_standard", noveltyJustification: null },
        { id: "sec_solutions", name: "Solutions Row", strategy: "NATIVE_NOVEL_BUILD", libraryEntryId: null, noveltyJustification: "3-column application grid not in current library" },
      ],
      humanEditProtection: { contentHash: null, lastBuiltByJobId: null, artifactVersion: null, humanEditDetected: false },
    }],
    buildStrategyDecisions: [
      { sectionId: "sec_hero", strategy: "LIBRARY_ASSEMBLY", rationale: "Standard hero pattern from approved library" },
      { sectionId: "sec_solutions", strategy: "NATIVE_NOVEL_BUILD", rationale: "No matching library entry; novelty justified" },
    ],
    warnings: [],
  },
  "other@1": { summary: "Stub output." },

  // CTOS-007: Website Audit Engine
  "audit_capture@1": {
    targetUrl: "https://example.com",
    capturedAt: "2026-01-01T00:00:00Z",
    pages: [{
      url: "https://example.com",
      statusCode: 200,
      title: "Example Business",
      metaDescription: null,
      h1: ["Welcome to our website"],
      h2: ["Our services", "Contact"],
      navLinks: [{ text: "About", href: "https://example.com/about" }, { text: "Contact", href: "https://example.com/contact" }],
      ctaTexts: ["Contact us"],
      formCount: 1,
      imageCount: 4,
      imagesWithoutAlt: 2,
      externalScriptHosts: [],
      hasAnalytics: false,
      contactSignals: ["tel:"],
      wordCount: 320,
      textExcerpt: "Welcome to our website. Our services. Contact us today.",
    }],
    skippedUrls: [],
    screenshots: [],
  },
  "audit_discovery@1": {
    targetUrl: "https://example.com",
    businessType: "Service business — professional services (inferred from contact and service page signals)",
    audienceSignals: ["Small business owners (inferred from service language)", "Local market (inferred from contact address pattern)"],
    primaryGoalSignal: "Lead generation via contact form (inferred from CTA patterns)",
    siteStructure: [{ url: "https://example.com", title: "Home", role: "Homepage / primary entry point" }],
    technicalSignals: ["WordPress (inferred from wp-content paths)", "No tracking scripts detected"],
    summary: "Stub discovery — no real site was analysed.",
  },
  "audit_architecture@1": {
    targetUrl: "https://example.com",
    navigationAssessment: "Navigation is present but lacks clear hierarchy (OBSERVED from HTML nav structure).",
    informationArchitecture: "Homepage-first structure with service and contact pages (OBSERVED).",
    uxFindings: [
      {
        id: "ux-no-search",
        category: "UX",
        severity: "MINOR",
        claimType: "OBSERVED",
        title: "No site search",
        detail: "No search functionality detected on the homepage.",
        evidence: "Homepage HTML: no search input or form found.",
        businessImpact: "Visitors cannot self-serve to find specific information.",
        affectedUrl: "https://example.com",
        estimatedEffort: "1–2 hours",
        recommendation: "Add WordPress search widget to header.",
        serviceOpportunity: null,
      },
    ],
    summary: "Stub architecture analysis — no real site was analysed.",
  },
  "audit_creative@1": {
    targetUrl: "https://example.com",
    visualVerificationStatus: "VISUAL_NOT_VERIFIED",
    structuralObservations: ["Single-column layout detected (OBSERVED from HTML structure)", "Hero section present (OBSERVED from first viewport content)"],
    creativeFindings: [
      {
        id: "creative-no-hero-image",
        category: "VISUAL",
        severity: "MAJOR",
        claimType: "OBSERVED",
        title: "No hero image detected in HTML",
        detail: "No img element or CSS background-image reference found in the above-fold area.",
        evidence: "Homepage HTML: no img tag or inline background-image in first 3000 chars.",
        businessImpact: "Text-only hero reduces immediate visual credibility.",
        affectedUrl: "https://example.com",
        estimatedEffort: "2–4 hours",
        recommendation: "Add a professional hero image relevant to the business.",
        serviceOpportunity: { service: "Visual Refresh", rationale: "No hero imagery detected", estimatedImpact: "MEDIUM" },
      },
    ],
    summary: "Stub creative analysis — VISUAL_NOT_VERIFIED (no screenshots). Structural HTML observations only.",
  },
  "audit_content_analysis@1": {
    targetUrl: "https://example.com",
    messagingAssessment: "Value proposition is not clearly stated above the fold (OBSERVED from H1 content).",
    seoFindings: ["Meta description absent (OBSERVED)", "H1 present but generic (OBSERVED)"],
    contentFindings: [
      {
        id: "content-weak-h1",
        category: "MESSAGE",
        severity: "MAJOR",
        claimType: "OBSERVED",
        title: "H1 is generic — no clear value proposition",
        detail: "The H1 reads 'Welcome to our website' — it does not communicate what the business does or who it serves.",
        evidence: "Homepage H1: 'Welcome to our website'",
        businessImpact: "Visitors cannot immediately understand what is on offer, increasing bounce rate.",
        affectedUrl: "https://example.com",
        estimatedEffort: "30 minutes",
        recommendation: "Rewrite H1 to state what the business does and for whom.",
        serviceOpportunity: { service: "Homepage Messaging Rewrite", rationale: "Generic H1 wastes the first impression", estimatedImpact: "HIGH" },
      },
    ],
    summary: "Stub content analysis — no real site was analysed.",
  },
  "audit_qa_review@1": {
    targetUrl: "https://example.com",
    challengedFindings: [
      { findingId: "content-weak-h1", verdict: "CONFIRMED", reason: "H1 text directly observed in captured HTML — claim is OBSERVED, not inferred." },
    ],
    additionalFindings: [],
    qualityScore: 8,
    summary: "Stub QA review — findings appear well-grounded. No rejected claims.",
  },
  "website_audit_report@1": {
    targetUrl: "https://example.com",
    auditType: "PUBLIC_PROSPECT",
    summary: "Stub audit report — no real site was analysed.",
    completionStatus: "HEURISTIC_ONLY",
    findings: [
      {
        id: "trust-no-reviews",
        agentId: null,
        category: "TRUST",
        severity: "MAJOR",
        claimType: "OBSERVED",
        title: "No social proof visible on homepage",
        detail: "The homepage carries no testimonials, reviews or client logos.",
        evidence: "Homepage inspection — no review widget or testimonial section found.",
        businessImpact: "Trust signals are absent — prospect cannot verify credibility before contacting.",
        affectedUrl: "https://example.com",
        estimatedEffort: "1–2 hours",
        recommendation: "Add a 3-review testimonial strip above the fold.",
        serviceOpportunity: { service: "Trust & Credibility Section", rationale: "Quick win — adds proof without structural changes", estimatedImpact: "HIGH" },
      },
    ],
    serviceOpportunities: [
      { service: "Trust & Credibility Section", rationale: "Homepage lacks social proof", estimatedImpact: "HIGH" },
    ],
    humanReviewQuestions: ["Do they have existing testimonials or case studies we could surface?"],
    capturedPages: ["https://example.com"],
    capturedAt: "2026-01-01T00:00:00Z",
  },

  // CTOS-006: WordPress Write Engine schemas
  "website_change_plan@1": {
    id: "wcp_stub",
    projectId: "proj_stub",
    siteConnectionId: "wsc_stub",
    sourceRequest: "Update hero heading to 'Welcome to U-Proof'",
    buildPackId: null,
    elementorManifestArtifactId: null,
    targetPageId: "page_home",
    targetPageTitle: "Home",
    actions: [
      {
        id: "act_001",
        type: "UPDATE_HEADING",
        permissionLevel: "GREEN",
        target: { pageId: "page_home", templateId: null, elementorElementId: "el_hero_heading", widgetId: null, containerId: null, sectionSemanticKey: "hero", contentSlotKey: "headline" },
        preconditions: [{ kind: "elementor_hash", expectedValue: "hash_abc123" }],
        payload: { field: "title", value: "Welcome to U-Proof" },
        idempotencyKey: "proj_stub:page_home:UPDATE_HEADING:el_hero_heading",
      },
    ],
    overallPermissionTier: "GREEN",
    backupRequired: true,
    verificationRequired: true,
    screenshotRequired: true,
    rollbackStrategy: "Restore prior revision snapshot.",
    humanApprovalsRequired: [],
    risks: ["Minor visual layout shift if heading length differs significantly from original"],
    status: "DRAFT",
    approvedById: null,
    approvedAt: null,
    executingJobId: null,
    createdByJobId: null,
    provenance: "CTOS-006 stub",
    createdAt: null,
    updatedAt: null,
  },
  "wp_write_result@1": {
    id: "wwr_stub",
    changePlanId: "wcp_stub",
    projectId: "proj_stub",
    siteConnectionId: "wsc_stub",
    status: "SUCCEEDED_VERIFIED",
    actionResults: [
      { actionId: "act_001", type: "UPDATE_HEADING", status: "SUCCEEDED", beforeValue: "Old Heading", afterValue: "Welcome to U-Proof", error: null, verificationPassed: true },
    ],
    beforeSnapshotId: "snap_stub",
    afterStateHash: "hash_xyz789",
    verificationResults: [{ field: "title", expected: "Welcome to U-Proof", actual: "Welcome to U-Proof", match: true }],
    startedAt: "2024-01-01T00:00:00Z",
    completedAt: "2024-01-01T00:00:05Z",
    transport: "FAKE",
    actorId: null,
    actorName: null,
    errors: [],
    rollbackStatus: "NOT_NEEDED",
    provenance: "CTOS-006 stub",
  },
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

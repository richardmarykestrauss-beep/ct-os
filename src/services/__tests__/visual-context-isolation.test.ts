/**
 * Imvusa / U-Proof visual-context isolation regression test (CTOS-005B Part 30).
 *
 * Proves deterministically — using fixture-level data, no live API calls — that
 * visual context from one project (simulating U-Proof) cannot leak into another
 * project's visual job pack, build manifest, or review context (simulating Imvusa).
 *
 * "DOCTRINE" and "AGENCY" knowledge is intentionally shared and is not a violation.
 * All PROJECT-scoped visual data must be strictly isolated by projectId.
 */
import { describe, it, expect } from "vitest";
import {
  assertVisualContextIsolation,
  assertRequiredSchemas005B,
} from "../benchmark-regression";
import type { OSData } from "@/data/types";
import { EMPTY } from "@/gateway/core";

// ---------------------------------------------------------------------------
// Fixture project IDs (symbolic names for the two benchmark projects)
// ---------------------------------------------------------------------------

const U_PROOF = "proj_u_proof";
const IMVUSA = "proj_imvusa";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeArtifact(id: string, projectId: string, type: string) {
  return {
    id, projectId, type: type as any, title: type,
    version: 1, status: "FINAL" as const, schemaVersion: 1,
    storageLocation: null, supersedesArtifactId: null,
    createdByAgentId: "agent_03", createdByProvider: null,
    content: {},
    createdAt: null, updatedAt: null,
  };
}

function makeVisualRef(id: string, projectId: string) {
  return {
    id, projectId, url: "https://ref.example.com", title: "Ref",
    description: "Visual reference", mode: "REIMAGINE" as const,
    addedByHuman: true, approvedBy: "Richard",
    approvedAt: null, createdAt: null,
  };
}

function makeSigElement(id: string, projectId: string) {
  return {
    id, projectId, description: "Sig element", rationale: "Brand identity",
    status: "APPROVED" as const,
    proposedByAgentId: null, approvedBy: null, approvedAt: null, createdAt: null,
  };
}

function makeDesignTokenSet(id: string, projectId: string) {
  return {
    id, projectId, version: 1, tokens: [],
    approvedBy: null, approvedAt: null, createdAt: null,
  };
}

function makeVisualDefect(id: string, projectId: string) {
  return {
    id, projectId, jobId: null,
    category: "LAYOUT" as const, severity: "P1" as const,
    description: "Layout defect", evidence: [],
    status: "OPEN" as const,
    detectedByAgentId: null, createdAt: null, resolvedAt: null,
  };
}

function makeScreenshot(id: string, projectId: string) {
  return {
    id, projectId, jobId: null,
    url: "https://ss.example.com",
    viewport: "desktop" as const, widthPx: 1440, heightPx: 900,
    capturedAt: null, captureStatus: "captured" as const,
    consoleErrors: [], loadErrors: [],
  };
}

function makeJob(id: string, projectId: string, taskType: string, inputArtifactIds: string[] = []) {
  return {
    id, projectId, agentId: "agent_03",
    taskType: taskType as any, instructions: "",
    inputArtifactIds, availableToolIds: [],
    requiredOutputSchema: "visual_review@1",
    requiredCapabilities: ["text", "structured_output", "vision"] as any,
    preferredProvider: "claude" as const, fallbackProviders: [],
    executionPriority: "QUALITY" as const,
    permissionLevel: "GREEN" as const, status: "QUEUED" as const,
    outputArtifactId: null, handoffId: null, requestedById: null,
    createdAt: null, updatedAt: null, startedAt: null, completedAt: null,
  };
}

function makeLesson(id: string, projectId: string) {
  return {
    id, projectId, agentId: "agent_03",
    knowledgeItemId: "ki-1", proposedScope: "PROJECT" as const,
    sourceArtifactId: null, sourceJobId: null,
    source: "CTOS-005B seed", status: "CANDIDATE" as const,
    reviewedBy: null, reviewedById: null, reviewedAt: null, createdAt: null,
  };
}

// ---------------------------------------------------------------------------
// Clean baseline — no cross-project pollution
// ---------------------------------------------------------------------------

describe("Imvusa/U-Proof isolation — clean baseline", () => {
  it("passes when each project has only its own visual context", () => {
    const data: OSData = {
      ...EMPTY,
      artifacts: [
        makeArtifact("a-dd", U_PROOF, "design_direction"),
        makeArtifact("a-pc", U_PROOF, "page_composition"),
        makeArtifact("b-dd", IMVUSA, "design_direction"),
        makeArtifact("b-pc", IMVUSA, "page_composition"),
      ],
      visualReferences: [
        makeVisualRef("vr-a", U_PROOF),
        makeVisualRef("vr-b", IMVUSA),
      ],
      screenshotEvidence: [
        makeScreenshot("ss-a", U_PROOF),
        makeScreenshot("ss-b", IMVUSA),
      ],
      visualDefects: [
        makeVisualDefect("vd-a", U_PROOF),
        makeVisualDefect("vd-b", IMVUSA),
      ],
    };
    const result = assertVisualContextIsolation(data, U_PROOF, IMVUSA);
    expect(result.isolated).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("passes for empty EMPTY snapshot", () => {
    const result = assertVisualContextIsolation(EMPTY, U_PROOF, IMVUSA);
    expect(result.isolated).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Visual reference isolation
// ---------------------------------------------------------------------------

describe("visual reference isolation", () => {
  it("detects visual reference appearing in both projects", () => {
    const shared = makeVisualRef("vr-shared", U_PROOF);
    const data: OSData = {
      ...EMPTY,
      visualReferences: [
        shared,
        { ...shared, projectId: IMVUSA },
      ],
    };
    const result = assertVisualContextIsolation(data, U_PROOF, IMVUSA);
    expect(result.isolated).toBe(false);
    expect(result.violations.some((v) => v.includes("vr-shared") && v.includes("VisualReference"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Screenshot evidence isolation
// ---------------------------------------------------------------------------

describe("screenshot evidence isolation", () => {
  it("detects screenshot appearing in both projects", () => {
    const ss = makeScreenshot("ss-shared", U_PROOF);
    const data: OSData = {
      ...EMPTY,
      screenshotEvidence: [
        ss,
        { ...ss, projectId: IMVUSA },
      ],
    };
    const result = assertVisualContextIsolation(data, U_PROOF, IMVUSA);
    expect(result.isolated).toBe(false);
    expect(result.violations.some((v) => v.includes("ss-shared"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Visual artifact isolation (design_direction, page_composition, visual_review, elementor_build_manifest)
// ---------------------------------------------------------------------------

describe("visual artifact isolation", () => {
  const types = ["design_direction", "page_composition", "visual_review", "elementor_build_manifest"] as const;

  for (const type of types) {
    it(`detects ${type} artifact shared between projects`, () => {
      const art = makeArtifact(`art-${type}`, U_PROOF, type);
      const data: OSData = {
        ...EMPTY,
        artifacts: [art, { ...art, projectId: IMVUSA }],
      };
      const result = assertVisualContextIsolation(data, U_PROOF, IMVUSA);
      expect(result.isolated).toBe(false);
      expect(result.violations.some((v) => v.includes(`art-${type}`))).toBe(true);
    });
  }

  it("does not flag non-visual artifact types", () => {
    const art = makeArtifact("art-sr", U_PROOF, "research_report");
    const data: OSData = {
      ...EMPTY,
      artifacts: [art, { ...art, projectId: IMVUSA }],
    };
    const result = assertVisualContextIsolation(data, U_PROOF, IMVUSA);
    expect(result.isolated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Visual job input isolation
// ---------------------------------------------------------------------------

describe("visual job input isolation", () => {
  it("detects Imvusa visual job referencing U-Proof artifact as input", () => {
    const uProofArt = makeArtifact("upr-art", U_PROOF, "design_direction");
    const data: OSData = {
      ...EMPTY,
      artifacts: [uProofArt],
      agentJobs: [makeJob("job-imvusa", IMVUSA, "visual_review", ["upr-art"])],
    };
    const result = assertVisualContextIsolation(data, U_PROOF, IMVUSA);
    expect(result.isolated).toBe(false);
    expect(result.violations.some((v) => v.includes("job-imvusa") && v.includes("upr-art"))).toBe(true);
  });

  it("allows Imvusa visual job referencing its own artifacts", () => {
    const imvusaArt = makeArtifact("imv-art", IMVUSA, "design_direction");
    const data: OSData = {
      ...EMPTY,
      artifacts: [imvusaArt],
      agentJobs: [makeJob("job-imvusa", IMVUSA, "visual_review", ["imv-art"])],
    };
    const result = assertVisualContextIsolation(data, U_PROOF, IMVUSA);
    expect(result.isolated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Visual defect isolation
// ---------------------------------------------------------------------------

describe("visual defect isolation", () => {
  it("detects visual defect shared between projects", () => {
    const defect = makeVisualDefect("vd-shared", U_PROOF);
    const data: OSData = {
      ...EMPTY,
      visualDefects: [defect, { ...defect, projectId: IMVUSA }],
    };
    const result = assertVisualContextIsolation(data, U_PROOF, IMVUSA);
    expect(result.isolated).toBe(false);
    expect(result.violations.some((v) => v.includes("vd-shared"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agent lesson isolation
// ---------------------------------------------------------------------------

describe("agent lesson isolation", () => {
  it("detects project-scoped lesson shared between projects", () => {
    const lesson = makeLesson("lesson-shared", U_PROOF);
    const data: OSData = {
      ...EMPTY,
      agentLessons: [lesson, { ...lesson, projectId: IMVUSA }],
    };
    const result = assertVisualContextIsolation(data, U_PROOF, IMVUSA);
    expect(result.isolated).toBe(false);
    expect(result.violations.some((v) => v.includes("lesson-shared"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Signature visual elements and design tokens
// ---------------------------------------------------------------------------

describe("signature visual element isolation", () => {
  it("detects element shared between projects", () => {
    const elem = makeSigElement("sve-shared", U_PROOF);
    const data: OSData = {
      ...EMPTY,
      signatureVisualElements: [elem, { ...elem, projectId: IMVUSA }],
    };
    const result = assertVisualContextIsolation(data, U_PROOF, IMVUSA);
    expect(result.isolated).toBe(false);
    expect(result.violations.some((v) => v.includes("sve-shared"))).toBe(true);
  });
});

describe("design token set isolation", () => {
  it("detects token set shared between projects", () => {
    const ts = makeDesignTokenSet("dts-shared", U_PROOF);
    const data: OSData = {
      ...EMPTY,
      designTokenSets: [ts, { ...ts, projectId: IMVUSA }],
    };
    const result = assertVisualContextIsolation(data, U_PROOF, IMVUSA);
    expect(result.isolated).toBe(false);
    expect(result.violations.some((v) => v.includes("dts-shared"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CTOS-005B schemas registration check
// ---------------------------------------------------------------------------

describe("005B schema registration", () => {
  it("all four CTOS-005B visual schemas are registered", () => {
    const result = assertRequiredSchemas005B();
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
  });
});

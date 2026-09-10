import { describe, it, expect } from "vitest";
import {
  VISUAL_REVIEW_REQUIRED_CAPS,
  requiresVisionCapability,
  enforceVisionCapability,
  routeVisualReviewJob,
  assembleVisualReviewJobPack,
} from "../visual-model-routing";
import type { AgentJob, OSData, ProviderCapability } from "@/data/types";
import { EMPTY } from "@/gateway/core";
import { AGENT_IDS } from "@/data/seed";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: "job-vr-1",
    projectId: "proj-1",
    agentId: AGENT_IDS.A03,
    taskType: "visual_review",
    instructions: "Review screenshots for visual quality",
    inputArtifactIds: [],
    availableToolIds: [],
    requiredOutputSchema: "visual_review@1",
    requiredCapabilities: ["text", "structured_output", "vision"],
    preferredProvider: "claude",
    fallbackProviders: ["openai", "gemini"],
    executionPriority: "QUALITY",
    permissionLevel: "GREEN",
    status: "QUEUED",
    outputArtifactId: null,
    handoffId: null,
    requestedById: null,
    createdAt: null,
    updatedAt: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

const visionCaps: ProviderCapability[] = ["text", "structured_output", "vision"];
const noVisionCaps: ProviderCapability[] = ["text", "structured_output", "code"];

// ---------------------------------------------------------------------------
// VISUAL_REVIEW_REQUIRED_CAPS
// ---------------------------------------------------------------------------

describe("VISUAL_REVIEW_REQUIRED_CAPS", () => {
  it("includes vision", () => {
    expect(VISUAL_REVIEW_REQUIRED_CAPS).toContain("vision");
  });

  it("includes text and structured_output", () => {
    expect(VISUAL_REVIEW_REQUIRED_CAPS).toContain("text");
    expect(VISUAL_REVIEW_REQUIRED_CAPS).toContain("structured_output");
  });
});

// ---------------------------------------------------------------------------
// requiresVisionCapability
// ---------------------------------------------------------------------------

describe("requiresVisionCapability", () => {
  it("returns true for visual_review", () => {
    expect(requiresVisionCapability("visual_review")).toBe(true);
  });

  it("returns false for other task types", () => {
    expect(requiresVisionCapability("build")).toBe(false);
    expect(requiresVisionCapability("qa_audit")).toBe(false);
    expect(requiresVisionCapability("creative_direction")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enforceVisionCapability
// ---------------------------------------------------------------------------

describe("enforceVisionCapability", () => {
  it("adds vision to VISUAL_REVIEW job that is missing it", () => {
    const job = makeJob({ requiredCapabilities: ["text", "structured_output"] });
    const enforced = enforceVisionCapability(job);
    expect(enforced.requiredCapabilities).toContain("vision");
  });

  it("does not duplicate vision when already present", () => {
    const job = makeJob();
    const enforced = enforceVisionCapability(job);
    expect(enforced.requiredCapabilities.filter((c) => c === "vision")).toHaveLength(1);
  });

  it("preserves A03 agent identity unchanged", () => {
    const job = makeJob();
    const enforced = enforceVisionCapability(job);
    expect(enforced.agentId).toBe(AGENT_IDS.A03);
    expect(enforced.taskType).toBe("visual_review");
    expect(enforced.projectId).toBe("proj-1");
  });

  it("does not modify non-VISUAL_REVIEW jobs", () => {
    const job = makeJob({ taskType: "build", requiredCapabilities: ["text", "structured_output", "code"] });
    const enforced = enforceVisionCapability(job);
    expect(enforced.requiredCapabilities).not.toContain("vision");
    expect(enforced).toEqual(job);
  });
});

// ---------------------------------------------------------------------------
// routeVisualReviewJob — preferred provider with vision
// ---------------------------------------------------------------------------

describe("routeVisualReviewJob — vision-capable preferred provider", () => {
  it("selects preferred provider when it has vision", () => {
    const decision = routeVisualReviewJob(
      ["claude", "openai"],
      { claude: visionCaps, openai: visionCaps },
    );
    expect(decision.provider).toBe("claude");
    expect(decision.fallbackToModeB).toBe(false);
    expect(decision.diagnostic).toContain("Preferred");
  });
});

// ---------------------------------------------------------------------------
// routeVisualReviewJob — non-vision preferred provider is rejected
// ---------------------------------------------------------------------------

describe("routeVisualReviewJob — non-vision preferred provider skipped", () => {
  it("skips preferred provider lacking vision and uses fallback", () => {
    const decision = routeVisualReviewJob(
      ["claude", "openai"],
      { claude: noVisionCaps, openai: visionCaps },
    );
    expect(decision.provider).toBe("openai");
    expect(decision.fallbackToModeB).toBe(false);
    expect(decision.diagnostic).toContain("fallback");
  });

  it("rejects provider with no vision even if it is the only one", () => {
    const decision = routeVisualReviewJob(
      ["claude"],
      { claude: noVisionCaps },
    );
    expect(decision.provider).toBeNull();
    expect(decision.fallbackToModeB).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// routeVisualReviewJob — no compatible provider → NEEDS_A_HAND / Mode B
// ---------------------------------------------------------------------------

describe("routeVisualReviewJob — no compatible provider", () => {
  it("returns fallbackToModeB true when no provider has vision", () => {
    const decision = routeVisualReviewJob(
      ["claude", "openai", "gemini"],
      { claude: noVisionCaps, openai: noVisionCaps, gemini: noVisionCaps },
    );
    expect(decision.provider).toBeNull();
    expect(decision.fallbackToModeB).toBe(true);
    expect(decision.diagnostic).toContain("Mode B");
  });

  it("diagnostic includes per-provider gap explanation", () => {
    const decision = routeVisualReviewJob(
      ["claude"],
      { claude: noVisionCaps },
    );
    expect(decision.diagnostic).toContain("vision");
  });

  it("returns fallbackToModeB when provider list is empty", () => {
    const decision = routeVisualReviewJob([]);
    expect(decision.provider).toBeNull();
    expect(decision.fallbackToModeB).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assembleVisualReviewJobPack — Mode B pack preserves screenshot evidence refs
// ---------------------------------------------------------------------------

describe("assembleVisualReviewJobPack — screenshot evidence preserved", () => {
  const baseData = (): OSData => ({
    ...EMPTY,
    agents: [
      {
        id: AGENT_IDS.A03,
        code: "A03",
        shortCode: "03",
        name: "Creative Director",
        role: "Visual direction",
        responsibilities: ["VISUAL_REVIEW pass"],
        status: "IDLE",
        outputsProduced: 1,
        providerPolicy: { preferred: "claude", fallbacks: ["openai"], reviewer: null },
        permissionLevel: "GREEN",
        requiredCapabilities: ["text", "structured_output", "vision"],
        producesArtifactTypes: ["design_system"],
        consumesArtifactTypes: ["site_blueprint"],
        canExecuteSiteChanges: false,
        defaultPriority: "QUALITY",
        lastRunAt: null, createdAt: null, updatedAt: null,
      },
    ],
    agentJobs: [makeJob()],
    screenshotEvidence: [
      { id: "ss-desk", projectId: "proj-1", jobId: null, url: "https://example.com/desk", viewport: "desktop", widthPx: 1440, heightPx: 900, capturedAt: "2024-01-01T00:00:00Z", captureStatus: "captured", consoleErrors: [], loadErrors: [] },
      { id: "ss-mob", projectId: "proj-1", jobId: null, url: "https://example.com/mob", viewport: "mobile", widthPx: 375, heightPx: 812, capturedAt: "2024-01-01T00:00:00Z", captureStatus: "captured", consoleErrors: [], loadErrors: [] },
      { id: "ss-other-proj", projectId: "proj-2", jobId: null, url: "https://other.com", viewport: "desktop", widthPx: 1440, heightPx: 900, capturedAt: "2024-01-01T00:00:00Z", captureStatus: "captured", consoleErrors: [], loadErrors: [] },
    ],
  });

  it("includes screenshot refs in evidenceExpectations", () => {
    const { jobPack, screenshotRefs } = assembleVisualReviewJobPack(baseData(), "job-vr-1");
    expect(screenshotRefs).toHaveLength(2);
    expect(jobPack.evidenceExpectations.some((e) => e.includes("ss-desk"))).toBe(true);
    expect(jobPack.evidenceExpectations.some((e) => e.includes("ss-mob"))).toBe(true);
  });

  it("does not include screenshots from other projects", () => {
    const { screenshotRefs } = assembleVisualReviewJobPack(baseData(), "job-vr-1");
    expect(screenshotRefs.every((r) => !r.screenshotId.includes("other-proj"))).toBe(true);
  });

  it("excludes failed captures from evidence refs", () => {
    const data = baseData();
    data.screenshotEvidence = [
      ...data.screenshotEvidence,
      { id: "ss-failed", projectId: "proj-1", jobId: null, url: "https://example.com/fail", viewport: "tablet", widthPx: 768, heightPx: 1024, capturedAt: null, captureStatus: "failed", consoleErrors: [], loadErrors: ["timeout"] },
    ];
    const { screenshotRefs } = assembleVisualReviewJobPack(data, "job-vr-1");
    expect(screenshotRefs.some((r) => r.screenshotId === "ss-failed")).toBe(false);
  });

  it("preserves A03 agent identity in assembled pack", () => {
    const { jobPack } = assembleVisualReviewJobPack(baseData(), "job-vr-1");
    expect(jobPack.agentId).toBe(AGENT_IDS.A03);
    expect(jobPack.agentCode).toBe("A03");
    expect(jobPack.jobId).toBe("job-vr-1");
    expect(jobPack.projectId).toBe("proj-1");
  });

  it("throws when job is not found", () => {
    expect(() => assembleVisualReviewJobPack(baseData(), "nonexistent-job")).toThrow("not found");
  });
});

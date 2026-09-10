import { describe, it, expect } from "vitest";
import { assessVisualVerification } from "../visual-verification";
import type { ScreenshotEvidence } from "@/data/types";

function makeEvidence(overrides: Partial<ScreenshotEvidence> = {}): ScreenshotEvidence {
  return {
    id: "ev-1",
    projectId: "proj-1",
    jobId: "job-1",
    url: "https://example.com",
    viewport: "desktop",
    widthPx: 1440,
    heightPx: 900,
    capturedAt: "2025-01-01T00:00:00Z",
    captureStatus: "captured",
    consoleErrors: [],
    loadErrors: [],
    ...overrides,
  };
}

// Case 1 — No screenshots
describe("assessVisualVerification — no screenshots", () => {
  it("returns VISUAL_NOT_VERIFIED for empty array", () => {
    expect(assessVisualVerification([])).toBe("VISUAL_NOT_VERIFIED");
  });
});

// Case 2 — Failed capture
describe("assessVisualVerification — failed capture", () => {
  it("returns VISUAL_NOT_VERIFIED when capture failed", () => {
    const ev = makeEvidence({ captureStatus: "failed" });
    expect(assessVisualVerification([ev])).toBe("VISUAL_NOT_VERIFIED");
  });

  it("returns VISUAL_NOT_VERIFIED when capture is pending", () => {
    const ev = makeEvidence({ captureStatus: "pending" });
    expect(assessVisualVerification([ev])).toBe("VISUAL_NOT_VERIFIED");
  });

  it("returns VISUAL_NOT_VERIFIED when all evidence failed", () => {
    const evs = [
      makeEvidence({ id: "ev-1", captureStatus: "failed" }),
      makeEvidence({ id: "ev-2", captureStatus: "failed" }),
    ];
    expect(assessVisualVerification(evs)).toBe("VISUAL_NOT_VERIFIED");
  });
});

// Case 3 — Valid screenshot evidence
describe("assessVisualVerification — valid capture", () => {
  it("returns VISUAL_VERIFIED when capture succeeded", () => {
    const ev = makeEvidence({ captureStatus: "captured" });
    expect(assessVisualVerification([ev])).toBe("VISUAL_VERIFIED");
  });

  it("returns VISUAL_VERIFIED when at least one of many captures succeeded", () => {
    const evs = [
      makeEvidence({ id: "ev-1", captureStatus: "failed" }),
      makeEvidence({ id: "ev-2", captureStatus: "captured" }),
    ];
    expect(assessVisualVerification(evs)).toBe("VISUAL_VERIFIED");
  });
});

// Case 4 — Cross-project evidence rejected
describe("assessVisualVerification — cross-project rejection", () => {
  it("returns VISUAL_NOT_VERIFIED when evidence is for a different project", () => {
    const ev = makeEvidence({ projectId: "proj-A", captureStatus: "captured" });
    expect(assessVisualVerification([ev], { projectId: "proj-B" })).toBe("VISUAL_NOT_VERIFIED");
  });

  it("returns VISUAL_VERIFIED when evidence matches the requested project", () => {
    const ev = makeEvidence({ projectId: "proj-A", captureStatus: "captured" });
    expect(assessVisualVerification([ev], { projectId: "proj-A" })).toBe("VISUAL_VERIFIED");
  });
});

// Case 5 — Wrong-job evidence rejected
describe("assessVisualVerification — wrong-job rejection", () => {
  it("returns VISUAL_NOT_VERIFIED when evidence is for a different job", () => {
    const ev = makeEvidence({ jobId: "job-A", captureStatus: "captured" });
    expect(assessVisualVerification([ev], { jobId: "job-B" })).toBe("VISUAL_NOT_VERIFIED");
  });

  it("returns VISUAL_VERIFIED when evidence matches the requested job", () => {
    const ev = makeEvidence({ jobId: "job-A", captureStatus: "captured" });
    expect(assessVisualVerification([ev], { jobId: "job-A" })).toBe("VISUAL_VERIFIED");
  });
});

// Case 6 — Combined filters
describe("assessVisualVerification — combined project+job filter", () => {
  it("returns VISUAL_NOT_VERIFIED when projectId matches but jobId does not", () => {
    const ev = makeEvidence({ projectId: "proj-1", jobId: "job-A", captureStatus: "captured" });
    expect(assessVisualVerification([ev], { projectId: "proj-1", jobId: "job-B" })).toBe("VISUAL_NOT_VERIFIED");
  });

  it("returns VISUAL_VERIFIED when both projectId and jobId match", () => {
    const ev = makeEvidence({ projectId: "proj-1", jobId: "job-1", captureStatus: "captured" });
    expect(assessVisualVerification([ev], { projectId: "proj-1", jobId: "job-1" })).toBe("VISUAL_VERIFIED");
  });

  it("jobId null in evidence does not match a specific jobId filter", () => {
    const ev = makeEvidence({ jobId: null, captureStatus: "captured" });
    expect(assessVisualVerification([ev], { jobId: "job-1" })).toBe("VISUAL_NOT_VERIFIED");
  });
});

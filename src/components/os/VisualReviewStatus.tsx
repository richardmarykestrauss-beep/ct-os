/**
 * VisualReviewStatusPanel (CTOS-005B Part 26).
 *
 * Compact operator-facing status panel for the post-build visual review gate.
 * Shows the current visual stage, screenshot coverage, defect counts, A06 QA
 * state, and human approval state so the operator can immediately understand
 * whether a project is ready to move forward.
 */
import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { OSData } from "@/data/types";
import { postBuildVisualStage, postBuildVisualStageAction } from "@/services/design-gates";
import { openBlockingDefects, visualDefectCounts } from "@/services/visual-defects";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  projectId: string;
  data: OSData;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stageTone(stage: ReturnType<typeof postBuildVisualStage>): "ok" | "warn" | "accent" | "neutral" {
  if (stage === "APPROVED") return "ok";
  if (stage === "HUMAN_APPROVAL") return "warn";
  if (stage === "A03_VISUAL_REVIEW" || stage === "A06_QA") return "accent";
  return "neutral";
}

function stageLabel(stage: ReturnType<typeof postBuildVisualStage>): string {
  const labels: Record<typeof stage, string> = {
    BUILD: "Build not complete",
    SCREENSHOT_CAPTURE: "Awaiting screenshots",
    A03_VISUAL_REVIEW: "Visual review not started",
    A06_QA: "Awaiting QA",
    HUMAN_APPROVAL: "Awaiting human design approval",
    APPROVED: "Visual review complete",
  };
  return labels[stage];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VisualReviewStatusPanel({ projectId, data }: Props) {
  const stage = postBuildVisualStage(data, projectId);
  const nextAction = postBuildVisualStageAction(stage);

  // Screenshot coverage
  const projectShots = data.screenshotEvidence.filter(
    (s) => s.projectId === projectId && s.captureStatus === "captured",
  );
  const hasDesktop = projectShots.some((s) => s.viewport === "desktop");
  const hasMobile = projectShots.some((s) => s.viewport === "mobile");
  const coverageComplete = hasDesktop && hasMobile;
  const missingShots: string[] = [];
  if (!hasDesktop) missingShots.push("Desktop screenshot missing");
  if (!hasMobile) missingShots.push("Mobile screenshot missing");

  // A03 visual review artifact
  const a03Review = data.artifacts.find(
    (a) => a.projectId === projectId && a.type === "visual_review" && a.createdByAgentId === "agent_03" && a.status !== "REJECTED",
  );

  // A06 QA review artifact
  const a06Review = data.artifacts.find(
    (a) => a.projectId === projectId && a.type === "visual_review" && a.createdByAgentId === "agent_06" && a.status !== "REJECTED",
  );

  // Visual defects
  const blocking = openBlockingDefects(data, projectId);
  const counts = visualDefectCounts(data, projectId);
  const criticalMajorOpen = (counts["P0"] ?? 0) + (counts["P1"] ?? 0);

  // Human design approval
  const designApproval = data.approvals.find(
    (a) => a.projectId === projectId && a.gate === "STAGING_BUILD",
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Visual Review</CardTitle>
        <Badge tone={stageTone(stage)}>{stageLabel(stage)}</Badge>
      </CardHeader>
      <CardContent className="grid gap-2 text-xs">

        {/* Screenshot coverage */}
        <Row label="Screenshots">
          {projectShots.length === 0 ? (
            <span className="text-muted">None captured</span>
          ) : coverageComplete ? (
            <span className="text-ok">Desktop + mobile ✓</span>
          ) : (
            <span className="text-warn">{missingShots.join(" · ")}</span>
          )}
        </Row>

        {/* A03 visual review */}
        <Row label="A03 Review">
          {a03Review ? (
            <span className="text-ok">
              {a03Review.status === "FINAL" ? "Complete (FINAL)" : `${a03Review.status.toLowerCase()}`}
            </span>
          ) : (
            <span className="text-muted">Not started</span>
          )}
        </Row>

        {/* Visual defects */}
        <Row label="Visual defects">
          {criticalMajorOpen > 0 ? (
            <span className="text-danger">
              {counts["P0"] ? `${counts["P0"]} CRITICAL` : ""}
              {counts["P0"] && counts["P1"] ? " · " : ""}
              {counts["P1"] ? `${counts["P1"]} MAJOR` : ""} unresolved
            </span>
          ) : blocking.length > 0 ? (
            <span className="text-warn">{blocking.length} blocking defect(s)</span>
          ) : (
            <span className="text-ok">No blocking defects</span>
          )}
        </Row>

        {/* A06 QA */}
        <Row label="A06 QA">
          {a06Review ? (
            <span className="text-ok">
              {a06Review.status === "FINAL" ? "Complete (FINAL)" : a06Review.status.toLowerCase()}
            </span>
          ) : stage === "A06_QA" ? (
            <span className="text-warn">In progress</span>
          ) : (
            <span className="text-muted">Pending</span>
          )}
        </Row>

        {/* Human design approval */}
        <Row label="Design approval">
          {!designApproval ? (
            <span className="text-muted">Not requested</span>
          ) : designApproval.status === "APPROVED" ? (
            <span className="text-ok">Approved by {designApproval.decidedBy ?? "human"}</span>
          ) : designApproval.status === "PENDING" ? (
            <span className="text-warn">Awaiting human approval</span>
          ) : (
            <span className="text-danger">Changes requested</span>
          )}
        </Row>

        {/* Next action */}
        {stage !== "APPROVED" && (
          <div className="mt-1 rounded-md bg-canvas px-2.5 py-2 text-[11px] text-ink-2">
            <span className="font-medium text-ink">Next: </span>
            {nextAction}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

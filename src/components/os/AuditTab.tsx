/**
 * CTOS-007A: Audit Tab — website audit intake, live pipeline state and results.
 *
 * Every step shown here is derived from store records (the request, its AgentJobs, their runs and
 * artifacts). Nothing is timed or simulated. Raw HTML/JS from audited sites is never rendered.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useOS } from "@/state/os-store";
import { validateAuditUrl } from "@/lib/audit-url";
import { deriveAuditSteps, type AuditStepState } from "@/services/audit-progress";
import type { AuditFinding, WebsiteAuditRequest } from "@/data/types";
import { AlertTriangle, CheckCircle2, Circle, Clock, Loader2, Play, Search, XCircle } from "lucide-react";

interface AuditTabProps {
  projectId?: string | null;
}

// ---------------------------------------------------------------------------
// Presentation maps
// ---------------------------------------------------------------------------

const SEVERITY_COLORS: Record<AuditFinding["severity"], string> = {
  CRITICAL: "bg-red-600 text-white",
  MAJOR: "bg-orange-500 text-white",
  MINOR: "bg-yellow-500 text-black",
  COSMETIC: "bg-slate-400 text-white",
};

const CATEGORY_LABELS: Record<AuditFinding["category"], string> = {
  TRAFFIC: "Traffic", MESSAGE: "Message", TRUST: "Trust", CONVERSION: "Conversion", FOLLOW_UP: "Follow-up",
  TECHNICAL: "Technical", SEO: "SEO", UX: "UX", VISUAL: "Visual", OTHER: "Other",
};

const REQUEST_LABEL: Record<WebsiteAuditRequest["status"], string> = {
  PENDING: "Queued", CAPTURING: "Capturing", RUNNING: "Running", ANALYSING: "Running", COMPLETE: "Complete",
  PARTIAL: "Partial", NEEDS_A_HAND: "Needs a hand", FAILED: "Failed", CANCELLED: "Cancelled",
};

function StatusIcon({ status }: { status: WebsiteAuditRequest["status"] }) {
  if (status === "COMPLETE") return <CheckCircle2 className="size-4 text-green-500" />;
  if (status === "PARTIAL" || status === "NEEDS_A_HAND") return <AlertTriangle className="size-4 text-orange-500" />;
  if (status === "FAILED" || status === "CANCELLED") return <XCircle className="size-4 text-red-500" />;
  if (status === "CAPTURING" || status === "RUNNING" || status === "ANALYSING") return <Loader2 className="size-4 animate-spin text-blue-400" />;
  return <Clock className="size-4 text-muted" />;
}

// ---------------------------------------------------------------------------
// Pipeline steps — derived (services/audit-progress), never simulated
// ---------------------------------------------------------------------------

type StepState = AuditStepState;

const STEP_TONE: Record<StepState, string> = {
  QUEUED: "text-muted", RUNNING: "text-blue-500", COMPLETE: "text-green-600", PARTIAL: "text-orange-500",
  FAILED: "text-red-500", NEEDS_A_HAND: "text-orange-500", CANCELLED: "text-muted",
};

function StepIcon({ state }: { state: StepState }) {
  if (state === "RUNNING") return <Loader2 className="size-3.5 animate-spin" />;
  if (state === "COMPLETE") return <CheckCircle2 className="size-3.5" />;
  if (state === "FAILED" || state === "CANCELLED") return <XCircle className="size-3.5" />;
  if (state === "PARTIAL" || state === "NEEDS_A_HAND") return <AlertTriangle className="size-3.5" />;
  return <Circle className="size-3.5" />;
}

// ---------------------------------------------------------------------------
// RunAuditPanel — URL input + launch
// ---------------------------------------------------------------------------

function RunAuditPanel({ projectId, onClose }: { projectId?: string | null; onClose: () => void }) {
  const { actions } = useOS();
  const [url, setUrl] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);

  async function handleRun() {
    setError(null);
    const v = validateAuditUrl(url);
    if (!v.ok) { setError(v.reason); return; }
    setRunning(true);
    onClose();
    try {
      const result = await actions.startAudit(v.normalised, "PUBLIC_PROSPECT", projectId ?? null);
      if (!result.ok) setError(result.reason);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card className="border border-ring/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Run Website Audit</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted">
          Enter any publicly accessible website URL. CT-OS captures the homepage and key public pages server-side, then runs A01 → A02 → A03 ‖ A04 → A06 as real agent jobs through the execution gateway. No login, form submission or site mutation occurs.
        </p>
        <div className="flex gap-2">
          <Input
            type="url"
            placeholder="https://example.com"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setError(null); }}
            onKeyDown={(e) => e.key === "Enter" && !running && handleRun()}
            className="flex-1 text-sm"
            disabled={running}
            aria-label="Website URL to audit"
          />
          <Button size="sm" onClick={handleRun} disabled={running || !url.trim()}>
            <Play className="size-3.5 mr-1" />
            {running ? "Starting…" : "Run Audit"}
          </Button>
        </div>
        {error && (
          <p className="flex items-center gap-1 text-xs text-red-500">
            <AlertTriangle className="size-3.5" /> {error}
          </p>
        )}
        <Button size="sm" variant="ghost" onClick={onClose} className="text-xs text-muted" disabled={running}>
          Cancel
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function FindingCard({ finding, agentLabel }: { finding: AuditFinding; agentLabel: string }) {
  return (
    <div className="rounded-md border border-border/60 p-3 space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_COLORS[finding.severity]}`}>{finding.severity}</span>
        <Badge tone="outline" className="text-[10px] uppercase">{CATEGORY_LABELS[finding.category]}</Badge>
        <Badge tone="outline" className="text-[10px]">{finding.claimType}</Badge>
        <Badge tone={finding.agentId ? "info" : "neutral"} className="text-[10px]">{agentLabel}</Badge>
        <span className="text-xs font-medium">{finding.title}</span>
      </div>
      <p className="text-xs text-muted">{finding.detail}</p>
      <p className="text-xs text-muted/70 italic">Evidence: {finding.evidence}</p>
      {finding.businessImpact && <p className="text-xs text-muted">Impact: {finding.businessImpact}</p>}
      {finding.recommendation && <p className="text-xs">Recommendation: {finding.recommendation}{finding.estimatedEffort ? ` (${finding.estimatedEffort})` : ""}</p>}
      {finding.serviceOpportunity && (
        <p className="text-[10px] text-blue-500">Service opportunity: {finding.serviceOpportunity.service} ({finding.serviceOpportunity.estimatedImpact} impact)</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AuditRequestCard
// ---------------------------------------------------------------------------

function AuditRequestCard({ request }: { request: WebsiteAuditRequest }) {
  const { data, actions } = useOS();
  const [expanded, setExpanded] = React.useState(false);
  const [showRaw, setShowRaw] = React.useState(false);
  const [showLog, setShowLog] = React.useState(false);
  const steps = React.useMemo(() => deriveAuditSteps(data, request), [data, request]);
  const allRows = data.auditFindings.filter((f) => f.auditRequestId === request.id);
  const rawRows = allRows.filter((f) => f.kind === "RAW");
  // Client-facing list = consolidated rows; pre-consolidation audits only have unmarked rows, show those.
  const findings = allRows.some((f) => f.kind === "CONSOLIDATED") ? allRows.filter((f) => f.kind === "CONSOLIDATED") : allRows.filter((f) => f.kind !== "RAW");
  const agentLabel = (agentId: string | null) => {
    if (!agentId) return "Heuristic";
    const a = data.agents.find((x) => x.id === agentId);
    return a ? `A${a.shortCode} ${a.name}` : agentId;
  };
  const settled = request.status === "COMPLETE" || request.status === "PARTIAL" || request.status === "NEEDS_A_HAND" || request.status === "FAILED";
  const report = request.resultArtifactId ? data.artifacts.find((a) => a.id === request.resultArtifactId) : null;
  const reportContent = report?.content as { overallVerdict?: string; evidenceGaps?: string[]; visualVerificationStatus?: string; topIssues?: string[]; coverage?: { pagesCaptured: number; pagesDiscovered: number; pagesSkipped: number; partial: boolean } } | undefined;

  return (
    <Card className="border border-border/60">
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <StatusIcon status={request.status} />
            <span className="text-sm font-medium truncate">{request.targetUrl}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge tone="outline" className="text-[10px]">{REQUEST_LABEL[request.status]}</Badge>
            {settled && !request.reviewedAt ? (
              <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => actions.markAuditReviewed(request.id)}>
                Mark reviewed
              </Button>
            ) : request.reviewedAt ? (
              <span className="text-[10px] text-muted">reviewed</span>
            ) : null}
          </div>
        </div>

        {request.failureReason && <p className="text-xs text-red-500">{request.failureReason}</p>}

        <ol className="grid gap-1 sm:grid-cols-2 lg:grid-cols-7">
          {steps.map((s) => (
            <li key={s.key} className={`flex items-start gap-1.5 rounded-md border border-border/40 px-2 py-1.5 text-[11px] ${STEP_TONE[s.state]}`} title={s.detail ?? undefined}>
              <span className="mt-0.5"><StepIcon state={s.state} /></span>
              <span className="min-w-0">
                <span className="block font-medium">{s.label}</span>
                <span className="block text-[10px] uppercase tracking-wide opacity-80">{s.state.replace(/_/g, " ")}</span>
                {s.detail ? <span className="block truncate text-[10px] text-muted">{s.detail}</span> : null}
              </span>
            </li>
          ))}
        </ol>

        {reportContent?.overallVerdict && (
          <div className="rounded-md bg-neutral-soft/40 p-2 text-xs">
            <div className="font-medium">{reportContent.overallVerdict}</div>
            {reportContent.coverage && (
              <div className="text-[11px] text-muted">
                Pages captured: {reportContent.coverage.pagesCaptured} · discovered: {reportContent.coverage.pagesDiscovered} · skipped: {reportContent.coverage.pagesSkipped}
                {reportContent.coverage.partial ? " · partial coverage — not site-wide" : ""}
              </div>
            )}
            {reportContent.visualVerificationStatus === "VISUAL_NOT_VERIFIED" && <div className="text-[11px] text-muted">Visual design not verified — no screenshots captured.</div>}
            {reportContent.evidenceGaps?.length ? <div className="mt-1 text-[11px] text-muted">Evidence gaps: {reportContent.evidenceGaps.length}</div> : null}
          </div>
        )}

        <div className="flex flex-wrap gap-3 text-xs">
          {findings.length > 0 && (
            <button className="text-blue-500 hover:underline" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Hide" : "Show"} {findings.length} finding(s)
            </button>
          )}
          {rawRows.length > 0 && (
            <button className="text-muted hover:underline" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? "Hide" : "View"} specialist evidence ({rawRows.length} raw)
            </button>
          )}
          {request.progressLog.length > 0 && (
            <button className="text-muted hover:underline" onClick={() => setShowLog((v) => !v)}>
              {showLog ? "Hide" : "Show"} log ({request.progressLog.length})
            </button>
          )}
        </div>

        {showLog && (
          <div className="space-y-0.5">
            {request.progressLog.map((msg, i) => (
              <p key={i} className="text-[11px] text-muted">{msg}</p>
            ))}
          </div>
        )}

        {expanded && (
          <div className="space-y-2">
            {findings.map((f) => (
              <FindingCard key={f.id} finding={f} agentLabel={f.contributors?.length ? f.contributors.map((c) => (c === "heuristic" ? "Heuristic" : agentLabel(c))).join(" + ") : agentLabel(f.agentId)} />
            ))}
          </div>
        )}

        {showRaw && (
          <div className="space-y-1 rounded-md border border-dashed border-border/40 p-2">
            <p className="text-[10px] uppercase tracking-wide text-muted">Raw specialist evidence — internal, not client-facing</p>
            {rawRows.map((f) => (
              <p key={f.id} className="text-[11px] text-muted">
                <span className="font-mono">{f.severity}</span> · {agentLabel(f.agentId)} · {f.title}{f.qaStatus ? ` · QA ${f.qaStatus.toLowerCase()}` : ""}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main AuditTab
// ---------------------------------------------------------------------------

export function AuditTab({ projectId }: AuditTabProps) {
  const { data } = useOS();
  const [showPanel, setShowPanel] = React.useState(false);

  const requests = data.websiteAuditRequests.filter((r) => (projectId ? r.projectId === projectId : true)).slice().reverse();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Website Audit</h3>
          <p className="text-xs text-muted">
            Public-facing audit of any website: server-side capture, then specialist agents A01–A06 as real jobs (see Runs and Agents), then a synthesised report. No login, form submission or site mutation.
          </p>
        </div>
        {!showPanel && (
          <Button size="sm" onClick={() => setShowPanel(true)}>
            <Search className="size-3.5 mr-1" />
            Run Audit
          </Button>
        )}
      </div>

      {showPanel && <RunAuditPanel projectId={projectId} onClose={() => setShowPanel(false)} />}

      {requests.length === 0 && !showPanel && (
        <div className="rounded-md border border-dashed border-border/40 p-6 text-center">
          <p className="text-xs text-muted">No audits yet. Click "Run Audit" to analyse a website.</p>
        </div>
      )}

      {requests.map((req) => (
        <AuditRequestCard key={req.id} request={req} />
      ))}
    </div>
  );
}

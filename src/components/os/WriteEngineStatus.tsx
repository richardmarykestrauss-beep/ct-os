/**
 * WriteEngineStatusPanel (CTOS-006 Part 23).
 *
 * Compact operator-facing status panel for the WordPress Write Engine.
 * Shows site connection health, active change plans, recent write results,
 * conflict/failure alerts, and pending approval items.
 *
 * Read-only: no mutations are performed here.
 * Security: no credentials, API keys, or auth tokens are rendered.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { OSData, WpConnectionStatus, WpChangePlanStatus, WpWriteResultStatus } from "@/data/types";

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

type BadgeTone = "ok" | "warn" | "danger" | "accent" | "neutral";

function connectionTone(status: WpConnectionStatus): BadgeTone {
  if (status === "ONLINE") return "ok";
  if (status === "UNCHECKED") return "neutral";
  if (status === "DECOMMISSIONED") return "neutral";
  return "danger";
}

function connectionLabel(status: WpConnectionStatus): string {
  const labels: Record<WpConnectionStatus, string> = {
    UNCHECKED: "Not checked",
    ONLINE: "Online",
    OFFLINE: "Offline",
    AUTH_FAILED: "Auth failed",
    DECOMMISSIONED: "Decommissioned",
  };
  return labels[status];
}

function planStatusTone(status: WpChangePlanStatus): BadgeTone {
  if (status === "COMPLETED") return "ok";
  if (status === "READY") return "warn";
  if (status === "EXECUTING") return "accent";
  if (status === "FAILED" || status === "ROLLED_BACK") return "danger";
  return "neutral";
}

function resultStatusTone(status: WpWriteResultStatus): BadgeTone {
  if (status === "SUCCEEDED_VERIFIED") return "ok";
  if (status === "CONFLICT_DETECTED" || status === "FAILED_READBACK") return "danger";
  if (
    status === "FAILED_CONNECTION" ||
    status === "FAILED_PERMISSION" ||
    status === "FAILED_VALIDATION" ||
    status === "FAILED_WRITE" ||
    status === "FAILED_ROLLBACK"
  ) return "danger";
  if (status === "NEEDS_A_HAND") return "warn";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WriteEngineStatusPanel({ projectId, data }: Props) {
  const connections = data.wpSiteConnections.filter((c) => c.projectId === projectId);
  const plans = data.websiteChangePlans
    .filter((p) => p.projectId === projectId)
    .slice()
    .sort((a, b) => (b.id > a.id ? 1 : -1))
    .slice(0, 5);
  const results = data.websiteWriteResults
    .filter((r) => r.projectId === projectId)
    .slice()
    .sort((a, b) => (b.id > a.id ? 1 : -1))
    .slice(0, 5);

  const pendingApprovals = plans.filter((p) => p.status === "READY");
  const conflicts = results.filter((r) => r.status === "CONFLICT_DETECTED");
  const failures = results.filter(
    (r) => r.status === "FAILED_WRITE" || r.status === "FAILED_READBACK" || r.status === "FAILED_CONNECTION",
  );

  if (connections.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Write Engine</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No WordPress site connection configured for this project.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Write Engine
          {pendingApprovals.length > 0 && (
            <Badge tone="warn">{pendingApprovals.length} pending approval</Badge>
          )}
          {conflicts.length > 0 && (
            <Badge tone="danger">{conflicts.length} conflict</Badge>
          )}
          {failures.length > 0 && (
            <Badge tone="danger">{failures.length} failed</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Site connections */}
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Site Connections
          </h4>
          <div className="space-y-1">
            {connections.map((conn) => {
              const tone = connectionTone(conn.connectionStatus);
              return (
                <div key={conn.id} className="flex items-center justify-between text-sm">
                  <span className="truncate max-w-[60%]" title={conn.siteUrl}>
                    {conn.siteUrl}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge tone={tone}>{connectionLabel(conn.connectionStatus)}</Badge>
                    <span className="text-xs text-muted-foreground">{conn.environment}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Change plans */}
        {plans.length > 0 && (
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Recent Change Plans
            </h4>
            <div className="space-y-1">
              {plans.map((plan) => {
                const tone = planStatusTone(plan.status);
                return (
                  <div key={plan.id} className="flex items-center justify-between text-sm">
                    <span className="truncate max-w-[60%]" title={plan.sourceRequest}>
                      {plan.targetPageTitle ?? plan.targetPageId} — {plan.actions.length} action(s)
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge tone={tone}>{plan.status}</Badge>
                      <span className="text-xs text-muted-foreground">{plan.overallPermissionTier}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Write results */}
        {results.length > 0 && (
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Recent Write Results
            </h4>
            <div className="space-y-1">
              {results.map((result) => {
                const tone = resultStatusTone(result.status);
                return (
                  <div key={result.id} className="flex items-center justify-between text-sm">
                    <span className="truncate max-w-[60%]" title={result.id}>
                      Plan {result.changePlanId} — {result.actionResults.length} action(s)
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge tone={tone}>{result.status}</Badge>
                      {result.errors.length > 0 && (
                        <span className="text-xs text-destructive">{result.errors.length} error(s)</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Conflict alert */}
        {conflicts.length > 0 && (
          <section className="rounded-md bg-destructive/10 border border-destructive/30 p-3">
            <p className="text-sm font-medium text-destructive">
              {conflicts.length} write conflict(s) detected — a human edited the page during an automated write. Review and re-approve the change plan.
            </p>
          </section>
        )}

      </CardContent>
    </Card>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { PageHeader, SectionTitle } from "@/components/os/PageHeader";
import { StatCard } from "@/components/os/StatCard";
import { LaunchHoldsPanel } from "@/components/os/LaunchHoldsPanel";
import { QAItemStatusBadge, SeverityBadge } from "@/components/os/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { QACategory, QAItemStatus } from "@/data/types";
import { agentById, qaSeverityCounts, useOS } from "@/state/os-store";
import { CheckCircle2 } from "lucide-react";

export const Route = createFileRoute("/qa")({ component: QAPage });

const CATEGORIES: QACategory[] = ["Responsive", "Visual", "Content", "WooCommerce", "SEO", "Forms", "Performance", "Technical", "Migration"];
const ITEM_STATUSES: QAItemStatus[] = ["OPEN", "IN_PROGRESS", "FIXED", "VERIFIED", "WONT_FIX"];

function QAPage() {
  const { data, actions } = useOS();
  const [projectId, setProjectId] = React.useState("all");
  const [category, setCategory] = React.useState<"all" | QACategory>("all");
  const [showResolved, setShowResolved] = React.useState(true);

  const items = data.qaItems
    .filter((q) => projectId === "all" || q.projectId === projectId)
    .filter((q) => category === "all" || q.category === category)
    .filter((q) => showResolved || q.status === "OPEN" || q.status === "IN_PROGRESS");
  const counts = qaSeverityCounts(data.qaItems.filter((q) => projectId === "all" || q.projectId === projectId));
  const holds = data.launchHolds.filter((h) => projectId === "all" || h.projectId === projectId);

  const lastAudit = [...data.tickets]
    .filter((t) => (projectId === "all" || t.projectId === projectId) && t.phase === "QA" && t.status === "COMPLETE" && /regression/i.test(t.title))
    .sort((a, b) => b.order - a.order)[0];

  return (
    <>
      <PageHeader
        title="QA"
        subtitle="Open defects by severity. Launch holds are tracked separately — they are not defects."
        actions={
          <NativeSelect value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-48">
            <option value="all">All projects</option>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="P0 Critical" value={counts.P0} tone={counts.P0 ? "danger" : "default"} />
        <StatCard label="P1 High" value={counts.P1} tone={counts.P1 ? "warn" : "default"} />
        <StatCard label="P2 Medium" value={counts.P2} tone={counts.P2 ? "accent" : "default"} />
        <StatCard label="P3 Low" value={counts.P3} />
        <Card className="flex flex-col justify-between px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{lastAudit ? "Final audit" : "Audit"}</div>
          {lastAudit ? (
            <>
              <div className="mt-1 flex items-center gap-1.5">
                {counts.total === 0 ? <CheckCircle2 className="size-5 text-ok" /> : null}
                <span className={counts.total === 0 ? "text-[22px] font-semibold text-ok" : "text-[22px] font-semibold text-danger"}>{counts.total === 0 ? "PASS" : "OPEN"}</span>
              </div>
              <div className="font-mono text-[11px] text-muted">{lastAudit.code}</div>
            </>
          ) : (
            <div className="mt-1 text-xs text-muted">No regression audit recorded.</div>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div>
          <SectionTitle
            right={
              <div className="flex flex-wrap items-center gap-2">
                <NativeSelect value={category} onChange={(e) => setCategory(e.target.value as typeof category)} className="h-7 w-36 text-xs">
                  <option value="all">All categories</option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </NativeSelect>
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
                </label>
              </div>
            }
          >
            QA issues
          </SectionTitle>
          <Card>
            <Table>
              <THead>
                <TR>
                  <TH>Issue</TH>
                  <TH>Page</TH>
                  <TH>Severity</TH>
                  <TH>Category</TH>
                  <TH className="hidden lg:table-cell">Description</TH>
                  <TH>Assigned</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((q) => {
                  const page = q.pageId ? data.pages.find((p) => p.id === q.pageId) : null;
                  const agent = agentById(data, q.assignedAgentId);
                  return (
                    <TR key={q.id}>
                      <TD className="min-w-[220px] font-medium">{q.title}</TD>
                      <TD className="whitespace-nowrap text-muted">{page?.title ?? (q.ticketId ? data.tickets.find((t) => t.id === q.ticketId)?.code : "—")}</TD>
                      <TD>
                        <SeverityBadge severity={q.severity} />
                      </TD>
                      <TD>
                        <Badge tone="outline">{q.category}</Badge>
                      </TD>
                      <TD className="hidden min-w-[280px] max-w-[420px] text-xs text-muted lg:table-cell">{q.description}</TD>
                      <TD className="whitespace-nowrap text-xs">{agent ? `${agent.shortCode} ${agent.name}` : "—"}</TD>
                      <TD>
                        <div className="flex items-center gap-1.5">
                          <QAItemStatusBadge status={q.status} />
                          <NativeSelect value={q.status} onChange={(e) => actions.setQAItemStatus(q.id, e.target.value as QAItemStatus)} className="h-6 w-28 px-1 text-[11px]">
                            {ITEM_STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {s.replace("_", " ")}
                              </option>
                            ))}
                          </NativeSelect>
                        </div>
                      </TD>
                    </TR>
                  );
                })}
                {!items.length ? (
                  <TR>
                    <TD colSpan={7} className="py-8 text-center text-xs text-muted">
                      No QA issues match the current filters.
                    </TD>
                  </TR>
                ) : null}
              </TBody>
            </Table>
          </Card>
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Categories</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((c) => {
                const n = data.qaItems.filter((q) => q.category === c && (q.status === "OPEN" || q.status === "IN_PROGRESS")).length;
                return (
                  <button key={c} onClick={() => setCategory(category === c ? "all" : c)} className="rounded-md border bg-surface px-2 py-1 text-xs hover:bg-canvas data-[on=true]:border-accent" data-on={category === c}>
                    {c} <span className="num ml-1 text-muted">{n}</span>
                  </button>
                );
              })}
            </CardContent>
          </Card>
        </div>
        <div>
          <SectionTitle>Launch holds (separate from defects)</SectionTitle>
          <LaunchHoldsPanel holds={holds} showProject={projectId === "all"} />
        </div>
      </div>
    </>
  );
}

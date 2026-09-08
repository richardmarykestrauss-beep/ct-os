import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { PageHeader } from "@/components/os/PageHeader";
import { TicketDrawer } from "@/components/os/TicketDrawer";
import { SeverityBadge } from "@/components/os/status";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/input";
import { TICKET_STATUSES, TICKET_STATUS_LABELS } from "@/data/state-machine";
import type { TicketStatus } from "@/data/types";
import { agentById, useOS } from "@/state/os-store";
import { cn } from "@/lib/utils";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/build-queue")({ component: BuildQueuePage });

const COL_TONE: Record<TicketStatus, string> = {
  QUEUED: "border-t-neutral",
  READY: "border-t-info",
  BUILDING: "border-t-accent",
  REVIEW: "border-t-warn",
  COMPLETE: "border-t-ok",
  BLOCKED: "border-t-danger",
};

function BuildQueuePage() {
  const { data, actions } = useOS();
  const [projectId, setProjectId] = React.useState<string>("all");
  const [open, setOpen] = React.useState<string | null>(null);
  const tickets = data.tickets.filter((t) => projectId === "all" || t.projectId === projectId);

  return (
    <>
      <PageHeader
        title="Build Queue"
        subtitle="Tickets by status. Move controls update the local store — no execution plane is connected."
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
      <div className="grid items-start gap-3 md:grid-cols-3 xl:grid-cols-6">
        {TICKET_STATUSES.map((status, colIdx) => {
          const list = tickets.filter((t) => t.status === status).sort((a, b) => b.order - a.order);
          return (
            <div key={status} className={cn("flex min-h-[160px] flex-col rounded-lg border border-t-[3px] bg-canvas", COL_TONE[status])}>
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-2">{TICKET_STATUS_LABELS[status]}</span>
                <span className="num rounded-sm bg-surface px-1.5 text-[11px] font-medium text-muted">{list.length}</span>
              </div>
              <div className="flex flex-1 flex-col gap-2 px-2 pb-2">
                {list.map((t) => {
                  const agent = agentById(data, t.agentId);
                  const project = data.projects.find((p) => p.id === t.projectId);
                  const prev = TICKET_STATUSES[colIdx - 1];
                  const next = TICKET_STATUSES[colIdx + 1];
                  return (
                    <Card key={t.id} className="group px-2.5 py-2">
                      <button className="w-full text-left" onClick={() => setOpen(t.id)}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10.5px] font-semibold text-muted">{t.code}</span>
                          <SeverityBadge severity={t.priority} />
                        </div>
                        <div className="mt-0.5 text-[12.5px] font-medium leading-snug text-ink">{t.title}</div>
                        <div className="mt-1 truncate text-[11px] text-muted">
                          {project?.name} · {agent?.shortCode} {agent?.name}
                        </div>
                        {t.warnings.length ? (
                          <div className="mt-1 flex items-center gap-1 text-[11px] text-warn">
                            <AlertTriangle className="size-3" /> {t.warnings.length} warning{t.warnings.length > 1 ? "s" : ""}
                          </div>
                        ) : null}
                      </button>
                      <div className="mt-1.5 flex items-center justify-between border-t pt-1.5 opacity-70 group-hover:opacity-100">
                        <button
                          disabled={!prev || status === "BLOCKED"}
                          onClick={() => prev && actions.setTicketStatus(t.id, prev)}
                          className="flex items-center gap-0.5 text-[10.5px] text-muted hover:text-ink disabled:invisible"
                        >
                          <ChevronLeft className="size-3" /> {prev ? TICKET_STATUS_LABELS[prev] : ""}
                        </button>
                        {status === "BLOCKED" ? (
                          <button onClick={() => actions.setTicketStatus(t.id, "READY")} className="text-[10.5px] text-accent hover:underline">
                            Unblock → Ready
                          </button>
                        ) : status !== "COMPLETE" ? (
                          <button onClick={() => actions.setTicketStatus(t.id, "BLOCKED")} className="text-[10.5px] text-muted hover:text-danger">
                            Block
                          </button>
                        ) : null}
                        <button
                          disabled={!next || next === "BLOCKED"}
                          onClick={() => next && actions.setTicketStatus(t.id, next)}
                          className="flex items-center gap-0.5 text-[10.5px] text-muted hover:text-ink disabled:invisible"
                        >
                          {next && next !== "BLOCKED" ? TICKET_STATUS_LABELS[next] : ""} <ChevronRight className="size-3" />
                        </button>
                      </div>
                    </Card>
                  );
                })}
                {!list.length ? <div className="flex flex-1 items-center justify-center rounded-md border border-dashed py-6 text-[11px] text-faint">Empty</div> : null}
              </div>
            </div>
          );
        })}
      </div>
      <TicketDrawer ticketId={open} onClose={() => setOpen(null)} />
    </>
  );
}

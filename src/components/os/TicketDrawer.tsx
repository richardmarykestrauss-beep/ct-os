import { Dialog, SheetContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { KV } from "./PageHeader";
import { SeverityBadge, TicketApprovalBadge, TicketStatusBadge } from "./status";
import { PHASE_LABELS } from "@/data/state-machine";
import { agentById, useOS } from "@/state/os-store";
import { AlertTriangle, CheckCircle2, ExternalLink, FlaskConical, RotateCcw, ShieldCheck } from "lucide-react";
import { formatRelative } from "@/lib/utils";
import { PROVIDER_LABELS } from "@/ai/registry";

export function TicketDrawer({ ticketId, onClose }: { ticketId: string | null; onClose: () => void }) {
  const { data, actions } = useOS();
  const ticket = ticketId ? data.tickets.find((t) => t.id === ticketId) : null;
  const agent = agentById(data, ticket?.agentId);
  const project = ticket ? data.projects.find((p) => p.id === ticket.projectId) : null;
  const artifact = ticket ? [...data.artifacts].reverse().find((a) => a.ticketId === ticket.id && a.status !== "SUPERSEDED") : null;
  const jobs = ticket ? data.agentJobs.filter((j) => j.ticketId === ticket.id) : [];
  const runs = jobs.flatMap((j) => data.agentRuns.filter((r) => r.jobId === j.id));

  return (
    <Dialog open={!!ticket} onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby={undefined}>
        {ticket ? (
          <>
            <div className="border-b px-5 py-4 pr-12">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-semibold text-ink-2">{ticket.code}</span>
                <TicketStatusBadge status={ticket.status} />
                <SeverityBadge severity={ticket.priority} />
              </div>
              <h2 className="mt-1.5 text-[15px] font-semibold text-ink">{ticket.title}</h2>
              <div className="mt-0.5 text-xs text-muted">
                {project?.name} · {PHASE_LABELS[ticket.phase]}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="grid gap-4">
                <Section title="Objective">
                  <p className="text-[13px] text-ink">{ticket.objective}</p>
                </Section>
                <div className="grid grid-cols-2 gap-3">
                  <KV label="Agent">
                    {agent ? (
                      <span>
                        <span className="font-mono text-[11px] text-muted">{agent.shortCode}</span> {agent.name}
                      </span>
                    ) : (
                      "—"
                    )}
                  </KV>
                  <KV label="Approval">
                    <TicketApprovalBadge state={ticket.approvalState} />
                  </KV>
                  <KV label="Environment">{ticket.environment}</KV>
                  <KV label="Updated">{ticket.updatedAt ? formatRelative(ticket.updatedAt) : <span className="text-faint">not recorded</span>}</KV>
                </div>
                <Section title="Scope">
                  <ChipList items={ticket.scope} empty="No scope items recorded." />
                </Section>
                <Section title="Do Not Change">
                  <ChipList items={ticket.doNotChange} tone="danger" empty="—" />
                </Section>
                <Section title="Execution Output">
                  <pre className="whitespace-pre-wrap rounded-md border bg-canvas px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink-2">{ticket.executionOutput ?? "No output yet."}</pre>
                </Section>
                <Section title="Safety Check">
                  <div className="flex items-start gap-2 rounded-md border border-ok/30 bg-ok-soft px-3 py-2 text-xs text-ink-2">
                    <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-ok" />
                    {ticket.safetyCheck ?? "Not yet evaluated."}
                  </div>
                </Section>
                <Section title="Warnings">
                  {ticket.warnings.length ? (
                    <ul className="grid gap-1.5">
                      {ticket.warnings.map((w) => (
                        <li key={w} className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-ink-2">
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" />
                          {w}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-xs text-muted">No warnings.</div>
                  )}
                </Section>
                {artifact ? (
                  <Section title="Linked artifact">
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                      <span className="text-ink">
                        {artifact.title} <span className="font-mono text-[11px] text-muted">v{artifact.version}</span>
                      </span>
                      <span className="flex gap-1">
                        <Badge tone="outline">{artifact.status}</Badge>
                        <Badge tone="outline">{artifact.storageLocation ? "File" : "Metadata only"}</Badge>
                      </span>
                    </div>
                  </Section>
                ) : null}
                {runs.length ? (
                  <Section title="Execution history">
                    <ul className="grid gap-1">
                      {runs.map((r) => (
                        <li key={r.id} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-xs">
                          <span className="text-ink">
                            <span className="font-mono text-[11px] text-muted">#{r.attempt}</span> {PROVIDER_LABELS[r.providerId]}
                            {r.error ? <span className="text-muted"> — {r.error}</span> : null}
                          </span>
                          <span className="flex items-center gap-1">
                            {r.latencyMs !== null ? <span className="font-mono text-[10px] text-muted">{r.latencyMs} ms</span> : null}
                            <Badge tone={r.status === "SUCCEEDED" ? "ok" : r.status === "FAILED" ? "danger" : r.status === "FAILED_VALIDATION" ? "warn" : "neutral"}>{r.status.toLowerCase().replace("_", " ")}</Badge>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 border-t px-5 py-3">
              <Button variant="accent" size="sm" onClick={() => actions.setTicketApproval(ticket.id, "APPROVED")} disabled={ticket.approvalState === "APPROVED" && ticket.status === "COMPLETE"}>
                <CheckCircle2 /> Approve
              </Button>
              <Button variant="outline" size="sm" onClick={() => actions.setTicketApproval(ticket.id, "NEEDS_REVISION")}>
                <RotateCcw /> Needs Revision
              </Button>
              <Button variant="outline" size="sm" onClick={() => actions.runQA(ticket.projectId)}>
                <FlaskConical /> Run QA
              </Button>
              <Button variant="ghost" size="sm" disabled={!ticket.executionOutput} onClick={() => document.getElementById("ticket-output")?.scrollIntoView({ behavior: "smooth" })}>
                <ExternalLink /> View Output
              </Button>
              <p className="col-span-2 text-[10.5px] text-faint">Actions update local store state only. No AI or WordPress execution plane is connected.</p>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section id={title === "Execution Output" ? "ticket-output" : undefined}>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{title}</div>
      {children}
    </section>
  );
}

function ChipList({ items, tone = "neutral", empty }: { items: string[]; tone?: "neutral" | "danger"; empty: string }) {
  if (!items.length) return <div className="text-xs text-muted">{empty}</div>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((s) => (
        <Badge key={s} tone={tone === "danger" ? "danger" : "outline"}>
          {s}
        </Badge>
      ))}
    </div>
  );
}

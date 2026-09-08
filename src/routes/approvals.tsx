import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { PageHeader, SectionTitle } from "@/components/os/PageHeader";
import { TicketDrawer } from "@/components/os/TicketDrawer";
import { ApprovalStatusBadge, TicketApprovalBadge } from "@/components/os/status";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { APPROVAL_GATE_LABELS } from "@/data/state-machine";
import { useOS } from "@/state/os-store";
import { formatRelative } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, RotateCcw, ShieldAlert } from "lucide-react";

export const Route = createFileRoute("/approvals")({ component: ApprovalsPage });

function ApprovalsPage() {
  const { data, actions } = useOS();
  const [open, setOpen] = React.useState<string | null>(null);
  const approvals = [...data.approvals].sort((a, b) => (a.status === "PENDING" ? -1 : 1) - (b.status === "PENDING" ? -1 : 1));
  const ticketApprovals = data.tickets.filter((t) => t.approvalState === "PENDING" || t.approvalState === "NEEDS_REVISION");

  return (
    <>
      <PageHeader title="Approvals" subtitle="Human approval gates. Launch cannot be approved by zero QA counts alone — a person decides." />
      <SectionTitle>Phase gates</SectionTitle>
      <Card>
        <Table>
          <THead>
            <TR>
              <TH>Project</TH>
              <TH>Gate</TH>
              <TH className="hidden md:table-cell">Requested By</TH>
              <TH>Status</TH>
              <TH className="hidden lg:table-cell">Notes</TH>
              <TH className="hidden md:table-cell">Decided</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {approvals.map((a) => {
              const project = data.projects.find((p) => p.id === a.projectId);
              const openHolds = data.launchHolds.filter((h) => h.projectId === a.projectId && !h.resolved).length;
              const isLaunch = a.gate === "LAUNCH";
              return (
                <TR key={a.id}>
                  <TD>
                    {project ? (
                      <Link to="/projects/$projectId" params={{ projectId: project.id }} className="font-medium hover:underline">
                        {project.name}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TD>
                  <TD>
                    <span className="font-medium">{APPROVAL_GATE_LABELS[a.gate]}</span>
                    {isLaunch && openHolds ? (
                      <div className="mt-0.5 flex items-center gap-1 text-[11px] text-hold">
                        <ShieldAlert className="size-3" /> {openHolds} open launch hold{openHolds > 1 ? "s" : ""}
                      </div>
                    ) : null}
                  </TD>
                  <TD className="hidden text-muted md:table-cell">{a.requestedBy}</TD>
                  <TD>
                    <ApprovalStatusBadge status={a.status} />
                  </TD>
                  <TD className="hidden max-w-[340px] text-xs text-muted lg:table-cell">{a.notes ?? "—"}</TD>
                  <TD className="hidden text-xs text-muted md:table-cell">
                    {a.decidedBy ? (
                      <>
                        {a.decidedBy}
                        <br />
                        {a.decidedAt ? formatRelative(a.decidedAt) : <span className="text-faint">time not recorded</span>}
                      </>
                    ) : (
                      "—"
                    )}
                  </TD>
                  <TD>
                    <div className="flex justify-end gap-1">
                      {a.status !== "APPROVED" ? (
                        <Button
                          size="sm"
                          variant="accent"
                          title={isLaunch && openHolds ? "Open launch holds remain — approving is a deliberate human decision" : undefined}
                          onClick={() => {
                            if (isLaunch && openHolds) {
                              const ok = window.confirm(`${openHolds} launch hold(s) are still open. Approve launch anyway? This is recorded as a deliberate human decision.`);
                              if (!ok) return;
                              actions.decideApproval(a.id, "APPROVED", `Approved by human with ${openHolds} open launch hold(s) explicitly accepted.`);
                              return;
                            }
                            actions.decideApproval(a.id, "APPROVED");
                          }}
                        >
                          <CheckCircle2 /> Approve
                        </Button>
                      ) : null}
                      {a.status !== "CHANGES_REQUESTED" ? (
                        <Button size="sm" variant="outline" onClick={() => actions.decideApproval(a.id, "CHANGES_REQUESTED")}>
                          <AlertTriangle /> Changes
                        </Button>
                      ) : null}
                      {a.status !== "PENDING" ? (
                        <Button size="sm" variant="ghost" onClick={() => actions.decideApproval(a.id, "PENDING")} title="Reset to pending">
                          <RotateCcw />
                        </Button>
                      ) : null}
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>

      <SectionTitle className="mt-6">Ticket output approvals</SectionTitle>
      <Card>
        {ticketApprovals.length ? (
          <Table>
            <THead>
              <TR>
                <TH>Ticket</TH>
                <TH>Project</TH>
                <TH>Title</TH>
                <TH>State</TH>
                <TH className="text-right">Review</TH>
              </TR>
            </THead>
            <TBody>
              {ticketApprovals.map((t) => (
                <TR key={t.id}>
                  <TD className="font-mono text-xs">{t.code}</TD>
                  <TD>{data.projects.find((p) => p.id === t.projectId)?.name}</TD>
                  <TD>{t.title}</TD>
                  <TD>
                    <TicketApprovalBadge state={t.approvalState} />
                  </TD>
                  <TD className="text-right">
                    <Button size="sm" variant="outline" onClick={() => setOpen(t.id)}>
                      Open ticket
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="px-4 py-6 text-center text-xs text-muted">
            No ticket outputs awaiting review. <Badge tone="outline">Run Next Ticket</Badge> on a project to exercise this flow.
          </div>
        )}
      </Card>
      <TicketDrawer ticketId={open} onClose={() => setOpen(null)} />
    </>
  );
}

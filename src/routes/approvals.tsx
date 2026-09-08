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
import { APPROVER_ROLES } from "@/services/job-approvals";
import { buildApprovalContext } from "@/services/approval-context";
import { PermissionTierBadge } from "@/components/os/status";
import { AlertTriangle, CheckCircle2, KeyRound, RotateCcw, ShieldAlert } from "lucide-react";

export const Route = createFileRoute("/approvals")({ component: ApprovalsPage });

function ApprovalsPage() {
  const { data, actions, user } = useOS();
  const [open, setOpen] = React.useState<string | null>(null);
  const canApprove = APPROVER_ROLES.includes(user.role);
  const jobApprovals = [...data.jobApprovals].sort((a, b) => (a.status === "PENDING" ? -1 : 1) - (b.status === "PENDING" ? -1 : 1));
  // RED jobs waiting for the current user's explicit authorization.
  const redJobs = data.agentJobs.filter((j) => j.status === "QUEUED").filter((j) => {
    const agent = data.agents.find((a) => a.id === j.agentId);
    const level = agent && (agent.permissionLevel === "RED" || j.permissionLevel === "RED") ? "RED" : null;
    return level === "RED" && !data.jobApprovals.some((a) => a.jobId === j.id && a.kind === "AUTHORIZATION" && a.approvedById === user.id && a.status === "APPROVED");
  });
  const approvals = [...data.approvals].sort((a, b) => (a.status === "PENDING" ? -1 : 1) - (b.status === "PENDING" ? -1 : 1));
  const ticketApprovals = data.tickets.filter((t) => t.approvalState === "PENDING" || t.approvalState === "NEEDS_REVISION");

  return (
    <>
      <PageHeader title="Approvals" subtitle="Human approval gates and job permissions. Launch cannot be approved by zero QA counts alone — a person decides." />

      <SectionTitle right={<span className="text-[11px] text-muted">AMBER needs a Production Lead or Admin. RED must be authorized by the person who runs it. The gateway re-checks server-side.</span>}>
        Job permissions
      </SectionTitle>
      <Card className="mb-6">
        <Table>
          <THead>
            <TR>
              <TH>Requested action</TH>
              <TH>Tier</TH>
              <TH className="hidden md:table-cell">Requested by</TH>
              <TH className="hidden md:table-cell">Approved by</TH>
              <TH>Status</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {jobApprovals.map((a) => {
              const ctx = buildApprovalContext(data, a);
              const { job, agent, project, ticket, inputArtifacts, tools, providerPolicy } = ctx;
              return (
                <TR key={a.id}>
                  <TD>
                    <div className="text-[11px] uppercase tracking-wide text-faint">Requester summary</div>
                    <div className="font-medium">{a.requestedAction}</div>
                    <div className="mt-0.5 text-[11px] text-muted">
                      {project?.name ?? "—"}
                      {ticket ? (
                        <>
                          {" · "}
                          <button onClick={() => setOpen(ticket.id)} className="font-mono text-accent hover:underline">
                            {ticket.code}
                          </button>
                        </>
                      ) : null}
                      {" · "}
                      <span className="font-mono text-faint">{a.actionFingerprint}</span>
                    </div>
                    {job ? (
                      <details className="mt-1.5 rounded-md border border-line/60 bg-canvas/60 px-2 py-1.5 text-[11px]">
                        <summary className="cursor-pointer select-none font-medium text-ink">Authoritative job details</summary>
                        <div className="mt-1.5 grid gap-1 text-muted">
                          <div>
                            <span className="text-faint">Agent: </span>
                            {agent ? `${agent.shortCode} ${agent.name}` : job.agentId}
                          </div>
                          <div>
                            <span className="text-faint">Task: </span>
                            {job.taskType.replace(/_/g, " ")} → <span className="font-mono">{job.requiredOutputSchema}</span>
                          </div>
                          <div>
                            <span className="text-faint">Instructions: </span>
                            <span className="whitespace-pre-wrap">{job.instructions}</span>
                          </div>
                          <div>
                            <span className="text-faint">Input artifacts: </span>
                            {inputArtifacts.length ? inputArtifacts.map((art) => `${art.title} (v${art.version})`).join(", ") : "none"}
                          </div>
                          <div>
                            <span className="text-faint">Tools requested: </span>
                            {tools.length ? tools.join(", ") : "none"}
                          </div>
                          {providerPolicy ? (
                            <div>
                              <span className="text-faint">Provider policy: </span>
                              {providerPolicy.preferred}
                              {providerPolicy.fallbacks.length ? ` → ${providerPolicy.fallbacks.join(" → ")}` : ""}
                            </div>
                          ) : null}
                        </div>
                      </details>
                    ) : (
                      <div className="mt-1 text-[11px] text-danger">Job {a.jobId} no longer exists — this approval cannot be executed.</div>
                    )}
                  </TD>
                  <TD>
                    <PermissionTierBadge tier={a.permissionLevel} />
                  </TD>
                  <TD className="hidden text-xs text-muted md:table-cell">{a.requestedByName}</TD>
                  <TD className="hidden text-xs text-muted md:table-cell">
                    {a.approvedByName ? (
                      <>
                        {a.approvedByName}
                        {a.approvedByRole ? <span className="text-faint"> · {a.approvedByRole.replace("_", " ").toLowerCase()}</span> : null}
                        <br />
                        {a.decidedAt ? formatRelative(a.decidedAt) : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </TD>
                  <TD>
                    <Badge tone={a.status === "APPROVED" ? "ok" : a.status === "PENDING" ? "warn" : a.status === "REJECTED" ? "danger" : "neutral"}>{a.status.toLowerCase()}</Badge>
                  </TD>
                  <TD>
                    <div className="flex justify-end gap-1.5">
                      {a.kind === "APPROVAL" && a.status === "PENDING" ? (
                        canApprove ? (
                          <>
                            <Button size="sm" variant="accent" onClick={() => actions.decideJobApproval(a.id, "APPROVED")}>
                              <CheckCircle2 /> Approve
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => actions.decideJobApproval(a.id, "REJECTED")}>
                              Reject
                            </Button>
                          </>
                        ) : (
                          <span className="text-[11px] text-muted">Needs a Production Lead / Admin</span>
                        )
                      ) : null}
                    </div>
                  </TD>
                </TR>
              );
            })}
            {redJobs.map((j) => {
              const agent = data.agents.find((a) => a.id === j.agentId);
              const ticket = j.ticketId ? data.tickets.find((t) => t.id === j.ticketId) : null;
              return (
                <TR key={`red-${j.id}`}>
                  <TD>
                    <div className="font-medium">
                      {agent ? `${agent.shortCode} ${agent.name}` : j.agentId}: {j.taskType.replace(/_/g, " ")} → {j.requiredOutputSchema}
                    </div>
                    <div className="text-[11px] text-muted">{ticket?.code ?? j.id} · awaiting your explicit authorization</div>
                  </TD>
                  <TD>
                    <PermissionTierBadge tier="RED" />
                  </TD>
                  <TD className="hidden text-xs text-muted md:table-cell">—</TD>
                  <TD className="hidden text-xs text-muted md:table-cell">—</TD>
                  <TD>
                    <Badge tone="danger">not authorized</Badge>
                  </TD>
                  <TD>
                    <div className="flex justify-end">
                      {canApprove ? (
                        <Button size="sm" variant="outline" onClick={() => actions.authorizeJob(j.id)} title="Authorizes this exact action for you only; you must then run it yourself">
                          <KeyRound /> Authorize for me
                        </Button>
                      ) : (
                        <span className="text-[11px] text-muted">Only a Production Lead / Admin can authorize</span>
                      )}
                    </div>
                  </TD>
                </TR>
              );
            })}
            {!jobApprovals.length && !redJobs.length ? (
              <TR>
                <TD colSpan={6} className="py-6 text-center text-xs text-muted">
                  No job approvals pending. GREEN jobs run automatically; AMBER and RED jobs appear here when someone tries to run them.
                </TD>
              </TR>
            ) : null}
          </TBody>
        </Table>
      </Card>

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

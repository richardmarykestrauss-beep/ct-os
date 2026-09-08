import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { PageHeader, EmptyState, KV, SectionTitle } from "@/components/os/PageHeader";
import { PipelineBar } from "@/components/os/Pipeline";
import { ActivityTimeline } from "@/components/os/ActivityTimeline";
import { LaunchHoldsPanel } from "@/components/os/LaunchHoldsPanel";
import { TicketDrawer } from "@/components/os/TicketDrawer";
import {
  AgentStatusBadge,
  ApprovalStatusBadge,
  BuildStatusBadge,
  HoldBadge,
  PHASE_STATUS_LABEL,
  PhaseStatusIcon,
  ProjectStateBadge,
  QAItemStatusBadge,
  QAStatusBadge,
  SeverityBadge,
  StatusLabel,
  TicketStatusBadge,
  WarningBadge,
} from "@/components/os/status";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tip } from "@/components/ui/tooltip";
import { APPROVAL_GATE_LABELS, PHASE_LABELS, PROJECT_STATE_LABELS, PROJECT_TYPE_LABELS, allowedTransitions } from "@/data/state-machine";
import type { ProjectPage, ProjectState } from "@/data/types";
import { agentById, qaSeverityCounts, useOS, useProject } from "@/state/os-store";
import { cn, formatRelative } from "@/lib/utils";
import { ARTIFACT_TYPE_LABELS } from "@/services/artifacts";
import { JOB_STATUS_LABELS } from "@/services/agent-jobs";
import { PROVIDER_LABELS } from "@/ai/registry";
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, Eye, FlaskConical, Play, ShieldCheck, ThumbsUp } from "lucide-react";

type Tab = "overview" | "pages" | "tickets" | "agents" | "artifacts" | "runs" | "qa" | "approvals" | "activity";

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectDetail,
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => ({ tab: typeof s.tab === "string" ? (s.tab as Tab) : undefined }),
});

function ProjectDetail() {
  const { projectId } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const view = useProject(projectId);
  const { data, actions } = useOS();
  const [openTicket, setOpenTicket] = React.useState<string | null>(null);

  if (!view) {
    return (
      <EmptyState
        title="Project not found"
        hint="It may have been created in a previous session — the MVP store is in-memory."
        action={
          <Button asChild variant="outline">
            <Link to="/projects">Back to projects</Link>
          </Button>
        }
      />
    );
  }

  const { project, client, phases, pages, tickets, artifacts, qaItems, launchHolds, approvals, activity, currentTicket, lastCompletedTicket, nextTicket, jobs, runs, handoffs } = view;
  const qa = qaSeverityCounts(qaItems);
  const openHolds = launchHolds.filter((h) => !h.resolved);
  const warnings = tickets.flatMap((t) => t.warnings.map((w) => ({ code: t.code, text: w })));
  const blockers = tickets.filter((t) => t.status === "BLOCKED");
  const launchApproval = approvals.find((a) => a.gate === "LAUNCH");
  const previewPage = pages.find((p) => p.title === "Homepage") ?? pages[0];
  const inFlight = (ticketId: string) => jobs.some((j) => j.ticketId === ticketId && (j.status === "RUNNING" || j.status === "WAITING_APPROVAL"));
  const runnable = nextTicket ?? tickets.find((t) => t.status === "BUILDING" && !inFlight(t.id));
  const reviewable = tickets.find((t) => t.status === "REVIEW" || t.approvalState === "PENDING") ?? lastCompletedTicket;
  const pendingGate = approvals.find((a) => a.status === "PENDING");

  const setTab = (t: Tab) => navigate({ search: { tab: t }, replace: true });

  return (
    <>
      <Link to="/projects" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> Projects
      </Link>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {project.name}
            <ProjectStateBadge state={project.state} />
          </span>
        }
        subtitle={
          <>
            {PROJECT_TYPE_LABELS[project.type]} · {project.platformSummary}
            {project.domain ? (
              <>
                {" · "}
                <a href={project.domain} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  {project.domain.replace(/^https?:\/\//, "")}
                </a>
              </>
            ) : null}
          </>
        }
        meta={
          <>
            <StatusLabel label={project.statusLabel} />
            <span className="text-xs text-muted">
              Phase: <span className="font-medium text-ink">{project.currentPhase}</span>
            </span>
            <span className="flex items-center gap-2 text-xs text-muted">
              <Progress value={project.progress} className="w-28" tone={project.progress >= 90 ? "ok" : "accent"} />
              <Tip label={project.progressNote ?? "Approximate production progress"}>
                <span className="num font-medium text-ink">≈ {project.progress}%</span>
              </Tip>
            </span>
          </>
        }
        actions={
          <>
            <Tip label={runnable ? `Runs ${runnable.code} (mock — moves to Review)` : "No queued ticket to run"}>
              <Button variant="accent" size="sm" disabled={!runnable} onClick={() => runnable && actions.runTicket(runnable.id)}>
                <Play /> Run Next Ticket
              </Button>
            </Tip>
            <Button variant="outline" size="sm" disabled={!reviewable} onClick={() => reviewable && setOpenTicket(reviewable.id)}>
              <Eye /> Review Output
            </Button>
            <Tip label={pendingGate ? `Approve ${APPROVAL_GATE_LABELS[pendingGate.gate]} gate` : "No pending gate"}>
              <Button
                variant="outline"
                size="sm"
                disabled={!pendingGate}
                onClick={() => {
                  if (!pendingGate) return;
                  if (pendingGate.gate === "LAUNCH" && openHolds.length) {
                    if (!window.confirm(`${openHolds.length} launch hold(s) are open. Approve launch anyway as a deliberate human decision?`)) return;
                    actions.decideApproval(pendingGate.id, "APPROVED", `Approved with ${openHolds.length} open hold(s) explicitly accepted.`);
                  } else actions.decideApproval(pendingGate.id, "APPROVED");
                }}
              >
                <ThumbsUp /> Approve Phase
              </Button>
            </Tip>
            <Button variant="outline" size="sm" onClick={() => actions.runQA(project.id)}>
              <FlaskConical /> Run QA
            </Button>
            <Tip label={previewPage?.wpRefId ? `${previewPage.title} · ${previewPage.wpRefKind === "TEMPLATE" ? "Template" : "Preview"} ${previewPage.wpRefId} — WordPress not connected` : "No preview reference"}>
              <Button variant="ghost" size="sm" disabled={!previewPage?.wpRefId} onClick={() => actions.note(project.id, `Open Preview requested for ${previewPage?.title} (${previewPage?.wpRefKind} ${previewPage?.wpRefId}) — WordPress execution plane not connected.`)}>
                <ExternalLink /> Open Preview
              </Button>
            </Tip>
          </>
        }
      />

      <Tabs value={tab ?? "overview"} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="pages">
            Pages <Count n={pages.length} />
          </TabsTrigger>
          <TabsTrigger value="tickets">
            Tickets <Count n={tickets.length} />
          </TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="artifacts">
            Artifacts <Count n={artifacts.length} />
          </TabsTrigger>
          <TabsTrigger value="runs">
            Runs {jobs.length ? <Count n={jobs.length} /> : null}
          </TabsTrigger>
          <TabsTrigger value="qa">
            QA {qa.total ? <Count n={qa.total} tone="danger" /> : null}
          </TabsTrigger>
          <TabsTrigger value="approvals">
            Approvals {approvals.filter((a) => a.status === "PENDING").length ? <Count n={approvals.filter((a) => a.status === "PENDING").length} tone="warn" /> : null}
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        {/* ------------------------------------------------------------ OVERVIEW */}
        <TabsContent value="overview">
          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="grid content-start gap-5">
              <Card>
                <CardHeader>
                  <CardTitle>Pipeline</CardTitle>
                  <span className="text-xs text-muted">
                    Next: <span className="font-medium text-ink">{project.nextAction}</span>
                  </span>
                </CardHeader>
                <CardContent>
                  <PipelineBar phases={phases} />
                </CardContent>
              </Card>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {phases.map((ph) => {
                  const phaseTickets = tickets.filter((t) => t.phase === ph.key);
                  const done = phaseTickets.filter((t) => t.status === "COMPLETE").length;
                  return (
                    <Card key={ph.id} className="px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12.5px] font-semibold text-ink">{ph.label}</span>
                        <PhaseStatusIcon status={ph.status} />
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted">{PHASE_STATUS_LABEL[ph.status]}</div>
                      <div className="num mt-1.5 text-[11px] text-muted">
                        {phaseTickets.length ? `${done}/${phaseTickets.length} tickets` : "No tickets recorded"}
                      </div>
                      {ph.note ? <div className="mt-1 text-[11px] text-hold">{ph.note}</div> : null}
                    </Card>
                  );
                })}
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Ticket position</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-3">
                  <TicketSlot label="Current ticket" ticket={currentTicket} empty="No active ticket" onOpen={setOpenTicket} />
                  <TicketSlot label="Last completed" ticket={lastCompletedTicket} empty="—" onOpen={setOpenTicket} />
                  <TicketSlot label="Next ticket" ticket={nextTicket} empty={project.nextAction} onOpen={setOpenTicket} />
                </CardContent>
              </Card>

              <div className="grid gap-5 md:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Blockers</CardTitle>
                    <Badge tone={blockers.length ? "danger" : "ok"}>{blockers.length ? blockers.length : "None"}</Badge>
                  </CardHeader>
                  <CardContent>
                    {blockers.length ? (
                      <ul className="grid gap-1.5">
                        {blockers.map((t) => (
                          <li key={t.id}>
                            <button onClick={() => setOpenTicket(t.id)} className="text-left text-xs hover:underline">
                              <span className="font-mono text-muted">{t.code}</span> {t.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="flex items-center gap-1.5 text-xs text-muted">
                        <ShieldCheck className="size-3.5 text-ok" /> No blocked tickets. {qa.total === 0 ? "No active code defect." : `${qa.total} open QA defect(s).`}
                      </div>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Warnings</CardTitle>
                    <Badge tone={warnings.length ? "warn" : "ok"}>{warnings.length || "None"}</Badge>
                  </CardHeader>
                  <CardContent>
                    {warnings.length ? (
                      <ul className="grid gap-1.5">
                        {warnings.map((w, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-xs">
                            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" />
                            <span>
                              <span className="font-mono text-muted">{w.code}</span> {w.text}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="text-xs text-muted">No ticket warnings.</div>
                    )}
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Project state</CardTitle>
                  <span className="text-xs text-muted">Manual transition (state machine enforced)</span>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-2">
                  <ProjectStateBadge state={project.state} />
                  <span className="text-xs text-muted">→</span>
                  {allowedTransitions(project.state).map((s: ProjectState) => (
                    <Button key={s} size="sm" variant={s === "ARCHIVED" ? "ghost" : "outline"} onClick={() => actions.transitionProject(project.id, s)}>
                      {PROJECT_STATE_LABELS[s]}
                    </Button>
                  ))}
                </CardContent>
              </Card>
            </div>

            <div className="grid content-start gap-5">
              <Card>
                <CardHeader>
                  <CardTitle>QA</CardTitle>
                  <Badge tone={qa.total === 0 ? "ok" : "danger"}>{qa.total === 0 ? "PASS" : `${qa.total} open`}</Badge>
                </CardHeader>
                <CardContent>
                  <div className="num grid grid-cols-4 gap-1 text-center font-mono text-xs">
                    {(["P0", "P1", "P2", "P3"] as const).map((s) => (
                      <div key={s} className="rounded-sm bg-canvas py-1.5">
                        <div className="text-faint">{s}</div>
                        <div className={cn("text-[16px] font-semibold", qa[s] ? "text-danger" : "text-ink")}>{qa[s]}</div>
                      </div>
                    ))}
                  </div>
                  {lastCompletedTicket && /regression/i.test(lastCompletedTicket.title) ? (
                    <div className="mt-2 text-[11px] text-muted">
                      Final regression audit <span className="font-mono">{lastCompletedTicket.code}</span> — ready for human review: <b className="text-ok">YES</b> · controlled activation testing: <b className="text-ok">YES</b>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
              <LaunchHoldsPanel holds={launchHolds} />
              {launchApproval ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Launch gate</CardTitle>
                    <ApprovalStatusBadge status={launchApproval.status} />
                  </CardHeader>
                  <CardContent className="text-xs text-muted">{launchApproval.notes ?? "Human approval required."}</CardContent>
                </Card>
              ) : null}
              <Card>
                <CardHeader>
                  <CardTitle>Client</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2">
                  <KV label="Name">{client?.name ?? "—"}</KV>
                  <KV label="Website">{client?.websiteUrl ?? "—"}</KV>
                  {project.primaryGoal ? <KV label="Primary goal">{project.primaryGoal}</KV> : null}
                  {project.notes ? <KV label="Notes">{project.notes}</KV> : null}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* ------------------------------------------------------------ PAGES */}
        <TabsContent value="pages">
          <PagesTab pages={pages} onOpenTicket={setOpenTicket} />
        </TabsContent>

        {/* ------------------------------------------------------------ TICKETS */}
        <TabsContent value="tickets">
          <Card>
            <Table>
              <THead>
                <TR>
                  <TH>Ticket ID</TH>
                  <TH>Title</TH>
                  <TH className="hidden md:table-cell">Agent</TH>
                  <TH className="hidden md:table-cell">Phase</TH>
                  <TH>Status</TH>
                  <TH>Priority</TH>
                  <TH>Warnings</TH>
                </TR>
              </THead>
              <TBody>
                {[...tickets].reverse().map((t) => {
                  const agent = agentById(data, t.agentId);
                  return (
                    <TR key={t.id} data-clickable="true" onClick={() => setOpenTicket(t.id)}>
                      <TD className="font-mono text-xs font-semibold text-ink-2">{t.code}</TD>
                      <TD className="font-medium">{t.title}</TD>
                      <TD className="hidden text-xs md:table-cell">
                        {agent ? (
                          <>
                            <span className="font-mono text-muted">{agent.shortCode}</span> {agent.name}
                          </>
                        ) : (
                          "—"
                        )}
                      </TD>
                      <TD className="hidden text-xs md:table-cell">{PHASE_LABELS[t.phase]}</TD>
                      <TD>
                        <TicketStatusBadge status={t.status} />
                      </TD>
                      <TD>
                        <SeverityBadge severity={t.priority} />
                      </TD>
                      <TD>
                        <WarningBadge count={t.warnings.length} />
                      </TD>
                    </TR>
                  );
                })}
                {!tickets.length ? (
                  <TR>
                    <TD colSpan={7} className="py-8 text-center text-xs text-muted">
                      No tickets yet.
                    </TD>
                  </TR>
                ) : null}
              </TBody>
            </Table>
          </Card>
        </TabsContent>

        {/* ------------------------------------------------------------ AGENTS */}
        <TabsContent value="agents">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.agents.map((a) => {
              const mine = tickets.filter((t) => t.agentId === a.id);
              const done = mine.filter((t) => t.status === "COMPLETE").length;
              return (
                <Card key={a.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[13px] font-semibold">
                        <span className="mr-1.5 font-mono text-[11px] text-muted">{a.shortCode}</span>
                        {a.name}
                      </div>
                      <div className="text-xs text-muted">{a.role}</div>
                    </div>
                    <AgentStatusBadge status={a.status} detail={a.currentProjectId === project.id ? a.statusDetail : undefined} />
                  </div>
                  <div className="num mt-2 text-[11px] text-muted">
                    {mine.length ? `${done}/${mine.length} tickets complete on this project` : "No tickets on this project"}
                  </div>
                </Card>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-muted">Agent statuses are global (an agent works one ticket at a time). See the Agents page for full cards.</p>
        </TabsContent>

        {/* ------------------------------------------------------------ ARTIFACTS */}
        <TabsContent value="artifacts">
          <Card>
            <Table>
              <THead>
                <TR>
                  <TH>Artifact</TH>
                  <TH>Type</TH>
                  <TH>Version</TH>
                  <TH>Status</TH>
                  <TH className="hidden md:table-cell">Created by</TH>
                  <TH className="hidden md:table-cell">Ticket</TH>
                  <TH>Storage</TH>
                  <TH className="hidden lg:table-cell">Summary</TH>
                </TR>
              </THead>
              <TBody>
                {[...artifacts].reverse().map((a) => {
                  const agent = agentById(data, a.createdByAgentId);
                  const ticket = a.ticketId ? tickets.find((t) => t.id === a.ticketId) : null;
                  return (
                    <TR key={a.id} className={a.status === "SUPERSEDED" ? "opacity-60" : undefined}>
                      <TD className="font-medium">{a.title}</TD>
                      <TD>
                        <Badge tone="outline">{ARTIFACT_TYPE_LABELS[a.type]}</Badge>
                      </TD>
                      <TD className="font-mono text-xs">
                        v{a.version}
                        {a.supersedesArtifactId ? <span className="text-faint"> ↑</span> : null}
                      </TD>
                      <TD>
                        <Badge tone={a.status === "FINAL" ? "ok" : a.status === "DRAFT" ? "warn" : a.status === "REJECTED" ? "danger" : "neutral"}>{a.status.toLowerCase()}</Badge>
                      </TD>
                      <TD className="hidden text-xs md:table-cell">
                        {agent ? `${agent.shortCode} ${agent.name}` : "—"}
                        {a.createdByProvider ? <span className="text-muted"> · {PROVIDER_LABELS[a.createdByProvider]}</span> : null}
                      </TD>
                      <TD className="hidden font-mono text-xs md:table-cell">{ticket?.code ?? "—"}</TD>
                      <TD>
                        <Badge tone={a.storageLocation ? "ok" : "neutral"}>{a.storageLocation ? "File" : "Metadata record"}</Badge>
                      </TD>
                      <TD className="hidden max-w-[360px] truncate text-xs text-muted lg:table-cell" title={a.summary}>
                        {a.summary ?? "—"}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </Card>
          <p className="mt-2 text-[11px] text-muted">Artifacts are versioned. A new version supersedes the previous one (↑). No file is claimed to exist until a storage location is attached.</p>
        </TabsContent>

        {/* ------------------------------------------------------------ RUNS */}
        <TabsContent value="runs">
          <Card>
            <Table>
              <THead>
                <TR>
                  <TH>Job</TH>
                  <TH>Agent</TH>
                  <TH>Status</TH>
                  <TH className="hidden md:table-cell">Provider</TH>
                  <TH className="hidden md:table-cell">Attempts</TH>
                  <TH className="hidden lg:table-cell">Handoff</TH>
                  <TH className="hidden lg:table-cell">Output</TH>
                  <TH></TH>
                </TR>
              </THead>
              <TBody>
                {[...jobs].reverse().map((j) => {
                  const agent = agentById(data, j.agentId);
                  const ticket = j.ticketId ? tickets.find((t) => t.id === j.ticketId) : null;
                  const jobRuns = runs.filter((r) => r.jobId === j.id);
                  const winner = jobRuns.find((r) => r.status === "SUCCEEDED");
                  const handoff = j.handoffId ? handoffs.find((h) => h.id === j.handoffId) : null;
                  const source = handoff ? agentById(data, handoff.sourceAgentId) : null;
                  const output = j.outputArtifactId ? artifacts.find((a) => a.id === j.outputArtifactId) : null;
                  const cancellable = j.status === "QUEUED" || j.status === "RUNNING" || j.status === "WAITING_APPROVAL";
                  return (
                    <TR key={j.id}>
                      <TD>
                        <div className="font-medium">{ticket?.code ?? j.taskType}</div>
                        <div className="text-[11px] text-muted">{j.taskType.replace(/_/g, " ")}</div>
                      </TD>
                      <TD className="text-xs">{agent ? `${agent.shortCode} ${agent.name}` : "—"}</TD>
                      <TD>
                        <Badge tone={j.status === "COMPLETED" ? "ok" : j.status === "FAILED" ? "danger" : j.status === "WAITING_APPROVAL" ? "warn" : j.status === "RUNNING" ? "accent" : "neutral"}>{JOB_STATUS_LABELS[j.status]}</Badge>
                      </TD>
                      <TD className="hidden text-xs md:table-cell">
                        {winner ? PROVIDER_LABELS[winner.providerId] : <span className="text-muted">preferred {PROVIDER_LABELS[j.preferredProvider]}</span>}
                        {winner && winner.providerId !== j.preferredProvider ? <span className="text-warn"> (fallback)</span> : null}
                      </TD>
                      <TD className="hidden text-xs md:table-cell">
                        {jobRuns.length ? jobRuns.map((r) => `${PROVIDER_LABELS[r.providerId]}: ${r.status.toLowerCase()}`).join(" · ") : <span className="text-faint">—</span>}
                      </TD>
                      <TD className="hidden text-xs lg:table-cell">{handoff ? `${source?.shortCode ?? "?"} → ${agent?.shortCode ?? "?"} · ${handoff.status.toLowerCase()}` : <span className="text-faint">—</span>}</TD>
                      <TD className="hidden text-xs lg:table-cell">{output ? `${output.title} v${output.version}` : j.error ? <span className="text-danger">{j.error}</span> : <span className="text-faint">—</span>}</TD>
                      <TD>
                        {cancellable ? (
                          <Button size="sm" variant="ghost" onClick={() => actions.cancelJob(j.id, "Cancelled by Production Lead")}>
                            Cancel
                          </Button>
                        ) : null}
                      </TD>
                    </TR>
                  );
                })}
                {!jobs.length ? (
                  <TR>
                    <TD colSpan={8} className="py-8 text-center text-xs text-muted">
                      No jobs yet. Run Next Ticket creates a job, routes it to a provider and records the result here.
                    </TD>
                  </TR>
                ) : null}
              </TBody>
            </Table>
          </Card>
          <p className="mt-2 text-[11px] text-muted">Every job records each provider attempt. Providers are stubs until their adapters are connected.</p>
        </TabsContent>

        {/* ------------------------------------------------------------ QA */}
        <TabsContent value="qa">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div>
              <div className="mb-3 grid grid-cols-4 gap-2">
                {(["P0", "P1", "P2", "P3"] as const).map((s) => (
                  <Card key={s} className="px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{s}</div>
                    <div className={cn("num text-[22px] font-semibold", qa[s] ? "text-danger" : "text-ink")}>{qa[s]}</div>
                  </Card>
                ))}
              </div>
              <Card>
                <Table>
                  <THead>
                    <TR>
                      <TH>Issue</TH>
                      <TH>Severity</TH>
                      <TH>Category</TH>
                      <TH className="hidden md:table-cell">Description</TH>
                      <TH>Status</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {qaItems.map((q) => (
                      <TR key={q.id}>
                        <TD className="font-medium">{q.title}</TD>
                        <TD>
                          <SeverityBadge severity={q.severity} />
                        </TD>
                        <TD>
                          <Badge tone="outline">{q.category}</Badge>
                        </TD>
                        <TD className="hidden max-w-[360px] text-xs text-muted md:table-cell">{q.description}</TD>
                        <TD>
                          <QAItemStatusBadge status={q.status} />
                        </TD>
                      </TR>
                    ))}
                    {!qaItems.length ? (
                      <TR>
                        <TD colSpan={5} className="py-8 text-center text-xs text-muted">
                          No QA items recorded.
                        </TD>
                      </TR>
                    ) : null}
                  </TBody>
                </Table>
              </Card>
            </div>
            <LaunchHoldsPanel holds={launchHolds} />
          </div>
        </TabsContent>

        {/* ------------------------------------------------------------ APPROVALS */}
        <TabsContent value="approvals">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {approvals.map((a) => (
              <Card key={a.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-[13px] font-semibold">{APPROVAL_GATE_LABELS[a.gate]}</div>
                  <ApprovalStatusBadge status={a.status} />
                </div>
                <div className="mt-1 text-xs text-muted">Requested by {a.requestedBy}</div>
                {a.notes ? <div className="mt-2 rounded-md bg-canvas px-2 py-1.5 text-[11.5px] text-ink-2">{a.notes}</div> : null}
                <div className="mt-3 flex gap-1.5">
                  {a.status !== "APPROVED" ? (
                    <Button
                      size="sm"
                      variant="accent"
                      onClick={() => {
                        if (a.gate === "LAUNCH" && openHolds.length) {
                          if (!window.confirm(`${openHolds.length} launch hold(s) are open. Approve launch anyway as a deliberate human decision?`)) return;
                          actions.decideApproval(a.id, "APPROVED", `Approved with ${openHolds.length} open hold(s) explicitly accepted.`);
                        } else actions.decideApproval(a.id, "APPROVED");
                      }}
                    >
                      <CheckCircle2 /> Approve
                    </Button>
                  ) : null}
                  {a.status !== "CHANGES_REQUESTED" ? (
                    <Button size="sm" variant="outline" onClick={() => actions.decideApproval(a.id, "CHANGES_REQUESTED")}>
                      Changes
                    </Button>
                  ) : null}
                  {a.status !== "PENDING" ? (
                    <Button size="sm" variant="ghost" onClick={() => actions.decideApproval(a.id, "PENDING")}>
                      Reset
                    </Button>
                  ) : null}
                </div>
                {a.decidedBy ? (
                  <div className="mt-2 text-[11px] text-muted">
                    {a.decidedBy} · {a.decidedAt ? formatRelative(a.decidedAt) : "time not recorded"}
                  </div>
                ) : null}
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ------------------------------------------------------------ ACTIVITY */}
        <TabsContent value="activity">
          <Card>
            <CardContent>
              <ActivityTimeline events={activity} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <TicketDrawer ticketId={openTicket} onClose={() => setOpenTicket(null)} />
    </>
  );
}

function Count({ n, tone = "neutral" }: { n: number; tone?: "neutral" | "danger" | "warn" }) {
  return (
    <span className={cn("num rounded-sm px-1 text-[10px] font-semibold", tone === "danger" ? "bg-danger-soft text-danger" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-neutral-soft text-muted")}>
      {n}
    </span>
  );
}

function TicketSlot({ label, ticket, empty, onOpen }: { label: string; ticket: { id: string; code: string; title: string; status: import("@/data/types").TicketStatus } | null; empty: string; onOpen: (id: string) => void }) {
  return (
    <div className="rounded-md border bg-canvas px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      {ticket ? (
        <button onClick={() => onOpen(ticket.id)} className="mt-1 block text-left hover:underline">
          <div className="font-mono text-[11px] text-ink-2">{ticket.code}</div>
          <div className="text-[13px] font-medium text-ink">{ticket.title}</div>
          <div className="mt-1">
            <TicketStatusBadge status={ticket.status} />
          </div>
        </button>
      ) : (
        <div className="mt-1 text-[13px] text-ink-2">{empty}</div>
      )}
    </div>
  );
}

type PageFilter = "all" | "complete" | "building" | "queued" | "qa" | "hold";
const FILTERS: { key: PageFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "complete", label: "Complete" },
  { key: "building", label: "Building" },
  { key: "queued", label: "Queued" },
  { key: "qa", label: "QA" },
  { key: "hold", label: "Blocked / Hold" },
];

function PagesTab({ pages, onOpenTicket }: { pages: ProjectPage[]; onOpenTicket: (id: string) => void }) {
  const [filter, setFilter] = React.useState<PageFilter>("all");
  const { data } = useOS();
  const filtered = pages.filter((p) => {
    switch (filter) {
      case "complete":
        return p.buildStatus === "COMPLETE";
      case "building":
        return p.buildStatus === "BUILDING";
      case "queued":
        return p.buildStatus === "QUEUED";
      case "qa":
        return p.qaStatus === "IN_QA" || p.qaStatus === "FAIL";
      case "hold":
        return !!p.holdNote;
      default:
        return true;
    }
  });
  const count = (f: PageFilter) =>
    pages.filter((p) => (f === "all" ? true : f === "complete" ? p.buildStatus === "COMPLETE" : f === "building" ? p.buildStatus === "BUILDING" : f === "queued" ? p.buildStatus === "QUEUED" : f === "qa" ? p.qaStatus === "IN_QA" || p.qaStatus === "FAIL" : !!p.holdNote)).length;

  return (
    <>
      <SectionTitle
        right={
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={cn("rounded-md border px-2 py-0.5 text-xs", filter === f.key ? "border-accent bg-accent-soft text-accent-strong" : "border-border bg-surface text-muted hover:text-ink")}
              >
                {f.label} <span className="num opacity-70">{count(f.key)}</span>
              </button>
            ))}
          </div>
        }
      >
        Tracked pages &amp; templates
      </SectionTitle>
      <Card>
        <Table>
          <THead>
            <TR>
              <TH>Page</TH>
              <TH>Type</TH>
              <TH>Build Status</TH>
              <TH>QA Status</TH>
              <TH>Preview / Template ID</TH>
              <TH className="hidden md:table-cell">Last Updated</TH>
              <TH className="hidden md:table-cell">Notes</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.map((p) => {
              const ticket = p.ticketId ? data.tickets.find((t) => t.id === p.ticketId) : null;
              return (
                <TR key={p.id}>
                  <TD className="font-medium">{p.title}</TD>
                  <TD className="text-xs text-muted">{p.type}</TD>
                  <TD>
                    <BuildStatusBadge status={p.buildStatus} />
                  </TD>
                  <TD>
                    <div className="flex flex-wrap items-center gap-1">
                      <QAStatusBadge status={p.qaStatus} />
                      {p.holdNote ? <HoldBadge label={p.holdNote} /> : null}
                    </div>
                  </TD>
                  <TD className="font-mono text-xs">
                    <span className="text-muted">{p.wpRefKind === "TEMPLATE" ? "Template" : "Preview"}</span> {p.wpRefId ?? "—"}
                  </TD>
                  <TD className="hidden text-xs text-muted md:table-cell">{p.updatedAt ? formatRelative(p.updatedAt) : <span className="text-faint">not recorded</span>}</TD>
                  <TD className="hidden max-w-[280px] text-xs text-muted md:table-cell">
                    {p.notes ? <span>{p.notes} </span> : null}
                    {ticket ? (
                      <button onClick={() => onOpenTicket(ticket.id)} className="font-mono text-[11px] text-accent hover:underline">
                        {ticket.code}
                      </button>
                    ) : null}
                  </TD>
                </TR>
              );
            })}
            {!filtered.length ? (
              <TR>
                <TD colSpan={7} className="py-8 text-center text-xs text-muted">
                  No pages match this filter.
                </TD>
              </TR>
            ) : null}
          </TBody>
        </Table>
      </Card>
    </>
  );
}

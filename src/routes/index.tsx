import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, BookOpen, Bot, CheckSquare, ClipboardCheck, FolderKanban, Hammer, Rocket } from "lucide-react";
import { PageHeader, SectionTitle } from "@/components/os/PageHeader";
import { StatCard } from "@/components/os/StatCard";
import { NewProjectDialog } from "@/components/os/NewProjectDialog";
import { PipelineBar, SafetyPipeline } from "@/components/os/Pipeline";
import { ActivityTimeline } from "@/components/os/ActivityTimeline";
import { LaunchHoldsPanel } from "@/components/os/LaunchHoldsPanel";
import { AgentStatusBadge, ProjectStateBadge, StatusLabel } from "@/components/os/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PROJECT_TYPE_LABELS } from "@/data/state-machine";
import { qaSeverityCounts, useDashboardStats, useOS } from "@/state/os-store";
import { Tip } from "@/components/ui/tooltip";

export const Route = createFileRoute("/")({ component: Overview });

function Overview() {
  const { data } = useOS();
  const stats = useDashboardStats();
  const navigate = useNavigate();
  const featured = [...data.projects].filter((p) => p.state !== "ARCHIVED").sort((a, b) => b.progress - a.progress);
  const recent = [...data.activity].sort((a, b) => b.order - a.order);

  return (
    <>
      <PageHeader title="Website Production" subtitle="AI-assisted website production command centre" actions={<NewProjectDialog />} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Active Projects" value={stats.activeProjects} icon={<FolderKanban />} onClick={() => navigate({ to: "/projects" })} />
        <StatCard label="In Build" value={stats.inBuild} icon={<Hammer />} tone={stats.inBuild ? "accent" : "default"} onClick={() => navigate({ to: "/build-queue" })} />
        <StatCard label="Awaiting Approval" value={stats.awaitingApproval} icon={<CheckSquare />} tone={stats.awaitingApproval ? "warn" : "default"} onClick={() => navigate({ to: "/approvals" })} />
        <StatCard label="QA Issues" value={stats.qaIssues} icon={<ClipboardCheck />} tone={stats.qaIssues ? "danger" : "ok"} hint="Open defects (P0–P3)" onClick={() => navigate({ to: "/qa" })} />
        <StatCard label="Ready to Launch" value={stats.readyToLaunch} icon={<Rocket />} tone={stats.readyToLaunch ? "hold" : "default"} hint="Pending human launch approval" />
      </div>

      <div className="mt-6 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid content-start gap-5">
          {featured.map((project) => {
            const phases = data.phases.filter((p) => p.projectId === project.id).sort((a, b) => a.order - b.order);
            const qa = qaSeverityCounts(data.qaItems.filter((q) => q.projectId === project.id));
            const holds = data.launchHolds.filter((h) => h.projectId === project.id && !h.resolved).length;
            const lastAudit = [...data.tickets].filter((t) => t.projectId === project.id && t.phase === "QA" && t.status === "COMPLETE").sort((a, b) => b.order - a.order)[0];
            const orchestrator = data.agents.find((a) => a.code === "ORCH");
            return (
              <Card key={project.id}>
                <CardHeader className="flex-wrap items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to="/projects/$projectId" params={{ projectId: project.id }} className="text-[16px] font-semibold text-ink hover:underline">
                        {project.name}
                      </Link>
                      <ProjectStateBadge state={project.state} />
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {PROJECT_TYPE_LABELS[project.type]} · {project.platformSummary}
                    </div>
                  </div>
                  <StatusLabel label={project.statusLabel} />
                </CardHeader>
                <CardContent className="grid gap-4">
                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="text-muted">Production progress</span>
                      <Tip label={project.progressNote ?? "Approximate"}>
                        <span className="num font-medium text-ink">≈ {project.progress}%</span>
                      </Tip>
                    </div>
                    <Progress value={project.progress} tone={project.progress >= 90 ? "ok" : "accent"} />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md border bg-canvas px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Current phase</div>
                      <div className="mt-0.5 text-[13px] font-medium text-ink">{project.currentPhase}</div>
                    </div>
                    <div className="rounded-md border bg-canvas px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Next</div>
                      <div className="mt-0.5 text-[13px] font-medium text-ink">{project.nextAction}</div>
                    </div>
                  </div>
                  <div>
                    <SectionTitle>Pipeline</SectionTitle>
                    <PipelineBar phases={phases} />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded-md border px-3 py-2">
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{lastAudit ? "Final audit" : "QA"}</div>
                        {lastAudit ? <Badge tone={qa.total === 0 ? "ok" : "danger"}>{qa.total === 0 ? "PASS" : "OPEN"}</Badge> : null}
                      </div>
                      <div className="num mt-1.5 grid grid-cols-4 gap-1 text-center font-mono text-[11px]">
                        {(["P0", "P1", "P2", "P3"] as const).map((s) => (
                          <div key={s} className="rounded-sm bg-canvas py-1">
                            <div className="text-faint">{s}</div>
                            <div className={qa[s] ? "font-semibold text-danger" : "font-semibold text-ink"}>{qa[s]}</div>
                          </div>
                        ))}
                      </div>
                      {lastAudit ? <div className="mt-1 font-mono text-[10px] text-muted">{lastAudit.code}</div> : null}
                    </div>
                    <div className="rounded-md border px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Launch holds</div>
                      <div className="num mt-1 text-[22px] font-semibold text-hold">{holds}</div>
                      <div className="text-[11px] text-muted">open · not defects</div>
                    </div>
                    <div className="rounded-md border px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Orchestrator</div>
                      <div className="mt-1.5">{orchestrator ? <AgentStatusBadge status={orchestrator.status} detail={orchestrator.statusDetail} /> : null}</div>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button asChild variant="outline" size="sm">
                      <Link to="/projects/$projectId" params={{ projectId: project.id }}>
                        Open project <ArrowRight />
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          <Card>
            <CardHeader>
              <CardTitle>Safety doctrine</CardTitle>
              <Link to="/settings" className="text-xs text-accent hover:underline">
                Permission model
              </Link>
            </CardHeader>
            <CardContent>
              <SafetyPipeline />
              <p className="mt-2 text-[11px] text-muted">Two human gates are mandatory. Zero QA defects never auto-approves a launch.</p>
            </CardContent>
          </Card>
        </div>

        <div className="grid content-start gap-5">
          <Card>
            <CardHeader>
              <CardTitle>Recent activity</CardTitle>
              <Link to="/projects" className="text-xs text-accent hover:underline">
                All projects
              </Link>
            </CardHeader>
            <CardContent className="max-h-[460px] overflow-y-auto">
              <ActivityTimeline events={recent} limit={12} dense />
            </CardContent>
          </Card>
          <LaunchHoldsPanel holds={data.launchHolds.filter((h) => !h.resolved)} title="Open launch holds" showProject />
          {stats.knowledgeCandidates ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  <BookOpen className="size-4 text-hold" /> Knowledge to review
                </CardTitle>
                <Link to="/knowledge" className="text-xs text-accent hover:underline">
                  Review
                </Link>
              </CardHeader>
              <CardContent className="text-xs text-muted">
                <span className="num font-medium text-ink">{stats.knowledgeCandidates}</span> lesson candidate{stats.knowledgeCandidates === 1 ? "" : "s"} proposed by agents are waiting for a human decision. Nothing becomes Agency knowledge until you approve it.
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Bot className="size-4 text-accent" /> Agents
              </CardTitle>
              <Link to="/agents" className="text-xs text-accent hover:underline">
                View all
              </Link>
            </CardHeader>
            <CardContent className="grid gap-1.5">
              {data.agents.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">
                    <span className="mr-1.5 font-mono text-[10px] text-muted">{a.shortCode}</span>
                    {a.name}
                  </span>
                  <AgentStatusBadge status={a.status} />
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

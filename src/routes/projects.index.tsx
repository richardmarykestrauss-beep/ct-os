import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/os/PageHeader";
import { NewProjectDialog } from "@/components/os/NewProjectDialog";
import { ProjectStateBadge, StatusLabel } from "@/components/os/status";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { PROJECT_TYPE_LABELS } from "@/data/state-machine";
import { useOS } from "@/state/os-store";
import { formatRelative } from "@/lib/utils";

export const Route = createFileRoute("/projects/")({ component: ProjectsPage });

function ProjectsPage() {
  const { data } = useOS();
  const navigate = useNavigate();
  const projects = [...data.projects].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  return (
    <>
      <PageHeader title="Projects" subtitle={`${projects.length} project${projects.length === 1 ? "" : "s"} in the production store`} actions={<NewProjectDialog />} />
      <Card>
        <Table>
          <THead>
            <TR>
              <TH>Project</TH>
              <TH>Client</TH>
              <TH>Type</TH>
              <TH className="hidden md:table-cell">Platform</TH>
              <TH>State</TH>
              <TH className="w-40">Progress</TH>
              <TH className="hidden lg:table-cell">Current Phase</TH>
              <TH className="hidden xl:table-cell">Next Action</TH>
              <TH className="hidden md:table-cell">Updated</TH>
            </TR>
          </THead>
          <TBody>
            {projects.map((p) => {
              const client = data.clients.find((c) => c.id === p.clientId);
              return (
                <TR key={p.id} data-clickable="true" onClick={() => navigate({ to: "/projects/$projectId", params: { projectId: p.id } })}>
                  <TD className="whitespace-nowrap">
                    <Link to="/projects/$projectId" params={{ projectId: p.id }} className="font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>
                      {p.name}
                    </Link>
                    <div className="mt-0.5">
                      <StatusLabel label={p.statusLabel} className="text-[10px]" />
                    </div>
                  </TD>
                  <TD className="whitespace-nowrap">{client?.name ?? "—"}</TD>
                  <TD className="whitespace-nowrap">{PROJECT_TYPE_LABELS[p.type]}</TD>
                  <TD className="hidden whitespace-nowrap text-muted md:table-cell">{p.platformSummary}</TD>
                  <TD>
                    <ProjectStateBadge state={p.state} />
                  </TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Progress value={p.progress} className="w-20" tone={p.progress >= 90 ? "ok" : "accent"} />
                      <span className="num text-xs text-muted">≈{p.progress}%</span>
                    </div>
                  </TD>
                  <TD className="hidden whitespace-nowrap lg:table-cell">{p.currentPhase}</TD>
                  <TD className="hidden max-w-[260px] truncate text-muted xl:table-cell">{p.nextAction}</TD>
                  <TD className="hidden whitespace-nowrap text-muted md:table-cell">{p.updatedAt ? formatRelative(p.updatedAt) : <span className="text-faint">not recorded</span>}</TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>
    </>
  );
}

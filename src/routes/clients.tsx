import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/os/PageHeader";
import { NewProjectDialog } from "@/components/os/NewProjectDialog";
import { ProjectStateBadge } from "@/components/os/status";
import { Card } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useOS } from "@/state/os-store";
import { formatRelative } from "@/lib/utils";
import { ExternalLink } from "lucide-react";

export const Route = createFileRoute("/clients")({ component: ClientsPage });

function ClientsPage() {
  const { data } = useOS();
  return (
    <>
      <PageHeader title="Clients" subtitle={`${data.clients.length} client${data.clients.length === 1 ? "" : "s"}`} actions={<NewProjectDialog />} />
      <Card>
        <Table>
          <THead>
            <TR>
              <TH>Client</TH>
              <TH>Website</TH>
              <TH>Projects</TH>
              <TH className="hidden md:table-cell">Notes</TH>
              <TH className="hidden md:table-cell">Created</TH>
            </TR>
          </THead>
          <TBody>
            {data.clients.map((c) => {
              const projects = data.projects.filter((p) => p.clientId === c.id);
              return (
                <TR key={c.id}>
                  <TD className="font-medium">{c.name}</TD>
                  <TD>
                    {c.websiteUrl ? (
                      <a href={c.websiteUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                        {c.websiteUrl.replace(/^https?:\/\//, "")} <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1.5">
                      {projects.map((p) => (
                        <Link key={p.id} to="/projects/$projectId" params={{ projectId: p.id }} className="inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs hover:bg-canvas">
                          {p.name} <ProjectStateBadge state={p.state} />
                        </Link>
                      ))}
                    </div>
                  </TD>
                  <TD className="hidden max-w-[320px] truncate text-xs text-muted md:table-cell">{c.notes ?? "—"}</TD>
                  <TD className="hidden text-xs text-muted md:table-cell">{c.createdAt ? formatRelative(c.createdAt) : <span className="text-faint">not recorded</span>}</TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>
    </>
  );
}

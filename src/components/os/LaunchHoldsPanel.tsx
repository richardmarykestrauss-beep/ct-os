import type { LaunchHold } from "@/data/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useOS } from "@/state/os-store";
import { cn } from "@/lib/utils";
import { CheckCircle2, Circle, PauseCircle } from "lucide-react";

export function LaunchHoldsPanel({ holds, title = "Launch Holds", showProject }: { holds: LaunchHold[]; title?: string; showProject?: boolean }) {
  const { actions, data } = useOS();
  const open = holds.filter((h) => !h.resolved).length;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-1.5">
            <PauseCircle className="size-4 text-hold" />
            {title}
          </CardTitle>
          <p className="mt-0.5 text-xs text-muted">Launch holds are not code defects. Each must be resolved or explicitly accepted before human launch approval.</p>
        </div>
        <Badge tone={open ? "hold" : "ok"}>{open ? `${open} open` : "None open"}</Badge>
      </CardHeader>
      <CardContent className="p-0">
        {holds.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted">No launch holds recorded.</div>
        ) : (
          <ul className="divide-y">
            {holds.map((h, i) => {
              const page = h.pageId ? data.pages.find((p) => p.id === h.pageId) : null;
              const project = showProject ? data.projects.find((p) => p.id === h.projectId) : null;
              return (
                <li key={h.id} className={cn("flex items-start gap-3 px-4 py-2.5", h.resolved && "bg-canvas/60")}>
                  <button
                    onClick={() => actions.toggleHold(h.id)}
                    className="mt-0.5 shrink-0 text-faint hover:text-accent"
                    aria-label={h.resolved ? "Reopen hold" : "Resolve hold"}
                    title={h.resolved ? "Reopen hold" : "Mark resolved"}
                  >
                    {h.resolved ? <CheckCircle2 className="size-4 text-ok" /> : <Circle className="size-4" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className={cn("text-[13px] text-ink", h.resolved && "text-muted line-through")}>
                      <span className="mr-1.5 font-mono text-[11px] text-faint">{i + 1}.</span>
                      {h.title}
                    </div>
                    {h.detail ? <div className="mt-1 rounded-md bg-canvas px-2 py-1.5 text-xs text-ink-2">{h.detail}</div> : null}
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                      {project ? <span className="font-medium text-ink-2">{project.name}</span> : null}
                      {page ? (
                        <span>
                          {page.title} · {page.wpRefKind === "TEMPLATE" ? "Template" : "Preview"} {page.wpRefId}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <Badge tone={h.owner === "Client" ? "info" : h.owner === "Creative Touch" ? "accent" : "outline"} className="shrink-0">
                    {h.owner}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

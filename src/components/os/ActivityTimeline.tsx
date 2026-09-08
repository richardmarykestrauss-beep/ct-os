import type { ActivityEvent } from "@/data/types";
import { formatRelative } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { AlertOctagon, Bot, BookOpen, CheckCircle2, CircleDot, Cpu, FilePlus2, FileText, FlaskConical, PauseCircle, Sparkles, StickyNote, Wrench, ArrowRightLeft } from "lucide-react";

const ICON: Record<ActivityEvent["kind"], { icon: typeof CircleDot; cls: string }> = {
  PROJECT_CREATED: { icon: Sparkles, cls: "text-accent" },
  STATE_CHANGED: { icon: ArrowRightLeft, cls: "text-info" },
  TICKET_CREATED: { icon: FilePlus2, cls: "text-info" },
  TICKET_STATUS: { icon: CircleDot, cls: "text-muted" },
  TICKET_COMPLETED: { icon: CheckCircle2, cls: "text-ok" },
  QA_RUN: { icon: FlaskConical, cls: "text-warn" },
  QA_PASS: { icon: CheckCircle2, cls: "text-ok" },
  QA_FIX: { icon: Wrench, cls: "text-info" },
  APPROVAL: { icon: AlertOctagon, cls: "text-warn" },
  HOLD: { icon: PauseCircle, cls: "text-hold" },
  AGENT: { icon: Bot, cls: "text-accent" },
  JOB: { icon: Cpu, cls: "text-accent" },
  ARTIFACT: { icon: FileText, cls: "text-info" },
  HANDOFF: { icon: ArrowRightLeft, cls: "text-info" },
  KNOWLEDGE: { icon: BookOpen, cls: "text-hold" },
  NOTE: { icon: StickyNote, cls: "text-muted" },
};

export function ActivityTimeline({ events, limit, dense }: { events: ActivityEvent[]; limit?: number; dense?: boolean }) {
  const list = limit ? events.slice(0, limit) : events;
  if (!list.length) return <div className="py-6 text-center text-xs text-muted">No activity yet.</div>;
  return (
    <ol className="relative">
      {list.map((e, i) => {
        const { icon: Icon, cls } = ICON[e.kind];
        return (
          <li key={e.id} className={cn("relative flex gap-3", dense ? "py-1.5" : "py-2")}>
            {i < list.length - 1 ? <span className="absolute left-[7px] top-6 h-full w-px bg-border" /> : null}
            <Icon className={cn("relative z-10 mt-0.5 size-4 shrink-0 bg-surface", cls)} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {e.ref ? <span className="font-mono text-[11px] font-semibold text-ink-2">{e.ref}</span> : null}
                <span className="text-[13px] text-ink">{e.message}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-muted">
                {e.actor}
                <span className="mx-1">·</span>
                {e.at ? formatRelative(e.at) : <span className="text-faint">seq #{e.order} · time not recorded</span>}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

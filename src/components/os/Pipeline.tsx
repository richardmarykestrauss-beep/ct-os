import type { ProjectPhase } from "@/data/types";
import { PHASE_STATUS_LABEL, PhaseStatusIcon } from "./status";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tooltip";
import { PHASES, SAFETY_PIPELINE } from "@/data/state-machine";
import { ChevronRight } from "lucide-react";

export function PipelineBar({ phases, compact }: { phases: ProjectPhase[]; compact?: boolean }) {
  return (
    <ol className={cn("flex w-full flex-wrap items-start gap-1", compact ? "text-[11px]" : "text-xs")}>
      {phases.map((ph) => {
        const tone =
          ph.status === "COMPLETE"
            ? "border-ok/30 bg-ok-soft text-ok"
            : ph.status === "IN_PROGRESS"
              ? "border-accent/30 bg-accent-soft text-accent-strong"
              : ph.status === "PENDING_HOLDS"
                ? "border-hold/30 bg-hold-soft text-hold"
                : ph.status === "BLOCKED"
                  ? "border-danger/30 bg-danger-soft text-danger"
                  : "border-border bg-canvas text-muted";
        return (
          <li key={ph.id} className="min-w-[100px] flex-1">
            <Tip label={`${ph.label}: ${PHASE_STATUS_LABEL[ph.status]}${ph.note ? ` — ${ph.note}` : ""}`}>
              <div className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1.5", tone)}>
                <PhaseStatusIcon status={ph.status} className="size-3.5" />
                <span className="truncate font-medium">{PHASES.find((p) => p.key === ph.key)?.short ?? ph.label}</span>
              </div>
            </Tip>
            {!compact ? <div className="mt-1 truncate px-0.5 text-[10px] text-muted">{PHASE_STATUS_LABEL[ph.status]}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Global safety doctrine strip. */
export function SafetyPipeline({ className }: { className?: string }) {
  return (
    <ol className={cn("flex flex-wrap items-center gap-1 text-[11px]", className)}>
      {SAFETY_PIPELINE.map((step, i) => {
        const human = step.startsWith("HUMAN");
        return (
          <li key={step} className="flex items-center gap-1">
            <span className={cn("rounded-sm border px-1.5 py-0.5 font-mono font-medium tracking-wide", human ? "border-warn/40 bg-warn-soft text-warn" : step === "LIVE" ? "border-ok/40 bg-ok-soft text-ok" : "border-border bg-surface text-ink-2")}>
              {step}
            </span>
            {i < SAFETY_PIPELINE.length - 1 ? <ChevronRight className="size-3 text-faint" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

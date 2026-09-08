import * as React from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  subtitle,
  actions,
  meta,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between", className)}>
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p> : null}
        {meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, right, className }: { children: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-2 flex flex-wrap items-center justify-between gap-2", className)}>
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{children}</h2>
      {right}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-surface px-6 py-10 text-center">
      <div className="text-[13px] font-medium text-ink-2">{title}</div>
      {hint ? <div className="mt-1 max-w-sm text-xs text-muted">{hint}</div> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function KV({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={cn("mt-0.5 text-[13px] text-ink", mono && "font-mono text-xs")}>{children}</div>
    </div>
  );
}

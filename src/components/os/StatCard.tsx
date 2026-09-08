import * as React from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = "default",
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: "default" | "ok" | "warn" | "danger" | "accent" | "hold";
  onClick?: () => void;
}) {
  const toneCls = {
    default: "text-ink",
    ok: "text-ok",
    warn: "text-warn",
    danger: "text-danger",
    accent: "text-accent-strong",
    hold: "text-hold",
  }[tone];
  return (
    <Card className={cn("px-4 py-3", onClick && "cursor-pointer hover:border-border-strong")} onClick={onClick} role={onClick ? "button" : undefined}>
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
        {icon ? <div className="text-faint [&_svg]:size-4">{icon}</div> : null}
      </div>
      <div className={cn("num mt-1 text-[26px] font-semibold leading-none tracking-tight", toneCls)}>{value}</div>
      {hint ? <div className="mt-1.5 text-[11px] text-muted">{hint}</div> : null}
    </Card>
  );
}

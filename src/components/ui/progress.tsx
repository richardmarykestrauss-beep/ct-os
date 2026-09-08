import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "@/lib/utils";

export function Progress({ value, className, tone = "accent" }: { value: number; className?: string; tone?: "accent" | "ok" | "warn" }) {
  const bar = tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : "bg-accent";
  return (
    <ProgressPrimitive.Root className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-neutral-soft", className)} value={value}>
      <ProgressPrimitive.Indicator className={cn("h-full transition-all", bar)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </ProgressPrimitive.Root>
  );
}

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-neutral-soft text-neutral border-transparent",
        ok: "bg-ok-soft text-ok border-transparent",
        warn: "bg-warn-soft text-warn border-transparent",
        danger: "bg-danger-soft text-danger border-transparent",
        info: "bg-info-soft text-info border-transparent",
        accent: "bg-accent-soft text-accent-strong border-transparent",
        hold: "bg-hold-soft text-hold border-transparent",
        outline: "bg-transparent text-ink-2 border-border-strong",
        dark: "bg-ink text-white border-transparent",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

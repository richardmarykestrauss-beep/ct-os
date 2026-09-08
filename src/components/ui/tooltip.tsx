import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content sideOffset={6} className="z-50 rounded-md bg-ink px-2 py-1 text-[11px] text-white shadow">
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

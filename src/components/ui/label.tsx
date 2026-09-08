import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";
import * as React from "react";

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn("text-xs font-medium text-ink-2", className)} {...props} />;
}

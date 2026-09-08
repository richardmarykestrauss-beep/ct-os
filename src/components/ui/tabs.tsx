import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";
import * as React from "react";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("flex items-center gap-1 overflow-x-auto border-b", className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "-mb-px inline-flex h-9 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 text-[13px] font-medium text-muted transition-colors hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink",
        className,
      )}
      {...props}
    />
  );
}
export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("pt-4 focus-visible:outline-none", className)} {...props} />;
}

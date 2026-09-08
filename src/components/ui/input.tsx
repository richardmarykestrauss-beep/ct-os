import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, type, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-8 w-full rounded-md border border-border-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "flex min-h-[72px] w-full rounded-md border border-border-strong bg-surface px-2.5 py-2 text-[13px] text-ink placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        className,
      )}
      {...props}
    />
  );
}

export function NativeSelect({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "flex h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-[13px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

import * as React from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PROJECT_TYPE_LABELS } from "@/data/state-machine";
import type { Platform, ProjectType } from "@/data/types";
import { useOS } from "@/state/os-store";
import { cn } from "@/lib/utils";

const PLATFORMS: Platform[] = ["WordPress", "Elementor", "WooCommerce", "Other"];
const TYPES = Object.keys(PROJECT_TYPE_LABELS) as ProjectType[];

const schema = z.object({
  clientName: z.string().trim().min(2, "Client name is required"),
  websiteUrl: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^https?:\/\/.+\..+/.test(v), "Enter a full URL, e.g. https://example.co.za"),
  type: z.enum(TYPES as [ProjectType, ...ProjectType[]]),
  primaryGoal: z.string().trim().min(5, "Describe the primary goal"),
  platforms: z.array(z.enum(PLATFORMS as [Platform, ...Platform[]])),
  hasExistingWebsite: z.enum(["yes", "no"]),
  notes: z.string().trim().optional(),
});

type FormValues = z.infer<typeof schema>;

export function NewProjectDialog({ trigger }: { trigger?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const { actions } = useOS();
  const navigate = useNavigate();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { clientName: "", websiteUrl: "", type: "NEW_WEBSITE", primaryGoal: "", platforms: ["WordPress", "Elementor"], hasExistingWebsite: "no", notes: "" },
  });

  const onSubmit = form.handleSubmit((v) => {
    const { projectId } = actions.createProject({
      clientName: v.clientName,
      websiteUrl: v.websiteUrl || undefined,
      type: v.type,
      primaryGoal: v.primaryGoal,
      platforms: v.platforms,
      hasExistingWebsite: v.hasExistingWebsite === "yes",
      notes: v.notes || undefined,
    });
    setOpen(false);
    form.reset();
    void navigate({ to: "/projects/$projectId", params: { projectId } });
  });

  const err = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="accent">
            <Plus /> New Project
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
            <DialogDescription>Creates the client, the project in Discovery, and the first Research &amp; Discovery ticket.</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-3.5">
            <Field label="Client Name" error={err.clientName?.message}>
              <Input placeholder="e.g. U-Proof" autoFocus {...form.register("clientName")} />
            </Field>
            <Field label="Website URL" error={err.websiteUrl?.message} hint="Optional">
              <Input placeholder="https://" {...form.register("websiteUrl")} />
            </Field>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label="Project Type">
                <NativeSelect {...form.register("type")}>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {PROJECT_TYPE_LABELS[t]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Existing Website">
                <NativeSelect {...form.register("hasExistingWebsite")}>
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </NativeSelect>
              </Field>
            </div>
            <Field label="Primary Goal" error={err.primaryGoal?.message}>
              <Input placeholder="e.g. Generate quote requests for commercial roofing" {...form.register("primaryGoal")} />
            </Field>
            <Field label="Platforms">
              <Controller
                control={form.control}
                name="platforms"
                render={({ field }) => (
                  <div className="flex flex-wrap gap-1.5">
                    {PLATFORMS.map((p) => {
                      const on = field.value.includes(p);
                      return (
                        <button
                          type="button"
                          key={p}
                          onClick={() => field.onChange(on ? field.value.filter((x) => x !== p) : [...field.value, p])}
                          className={cn(
                            "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                            on ? "border-accent bg-accent-soft text-accent-strong" : "border-border-strong bg-surface text-ink-2 hover:bg-canvas",
                          )}
                          aria-pressed={on}
                        >
                          {p}
                        </button>
                      );
                    })}
                  </div>
                )}
              />
            </Field>
            <Field label="Notes" hint="Optional">
              <Textarea placeholder="Context, constraints, stakeholders…" {...form.register("notes")} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent">
              Create Project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between">
        <Label>{label}</Label>
        {hint ? <span className="text-[11px] text-faint">{hint}</span> : null}
      </div>
      {children}
      {error ? <div className="text-[11px] text-danger">{error}</div> : null}
    </div>
  );
}

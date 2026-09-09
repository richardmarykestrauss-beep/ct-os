import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/os/PageHeader";
import { AgentStatusBadge } from "@/components/os/status";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/input";
import { useOS } from "@/state/os-store";
import { cn, formatRelative } from "@/lib/utils";
import type { AgentStatus, ProviderId } from "@/data/types";
import { PROVIDER_IDS, PROVIDER_LABELS } from "@/ai/registry";
import { useGatewayHealth } from "@/gateway/useGatewayHealth";
import { ProviderStateBadge } from "@/components/os/status";
import { SKILL_STATUS_LABELS } from "@/services/skills";
import { Bot, Crown } from "lucide-react";

export const Route = createFileRoute("/agents")({ component: AgentsPage });

const RING: Record<AgentStatus, string> = {
  IDLE: "border-border",
  WORKING: "border-accent shadow-[0_0_0_3px_var(--color-accent-soft)]",
  WAITING_APPROVAL: "border-warn shadow-[0_0_0_3px_var(--color-warn-soft)]",
  BLOCKED: "border-danger shadow-[0_0_0_3px_var(--color-danger-soft)]",
};

function AgentsPage() {
  const { data, actions, user } = useOS();
  const { health } = useGatewayHealth();
  const providerState = (id: ProviderId) => health?.providers.find((p) => p.id === id) ?? null;
  const canEdit = user.role === "ADMIN" || user.role === "PRODUCTION_LEAD";
  const counts = data.agents.reduce<Record<AgentStatus, number>>(
    (acc, a) => ({ ...acc, [a.status]: acc[a.status] + 1 }),
    { IDLE: 0, WORKING: 0, WAITING_APPROVAL: 0, BLOCKED: 0 },
  );
  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Specialist agents coordinated by the Orchestrator. Each agent keeps its identity; the provider behind it can change. Providers are stubs until connected."
        meta={(Object.keys(counts) as AgentStatus[]).map((s) => (
          <span key={s} className="text-xs text-muted">
            <AgentStatusBadge status={s} /> <span className="num ml-1 font-medium text-ink">{counts[s]}</span>
          </span>
        ))}
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.agents.map((a) => {
          const project = a.currentProjectId ? data.projects.find((p) => p.id === a.currentProjectId) : null;
          const ticket = a.currentTicketId ? data.tickets.find((t) => t.id === a.currentTicketId) : null;
          const isOrch = a.code === "ORCH";
          const lastRun = [...data.agentRuns].reverse().find((r) => r.agentId === a.id && r.status === "SUCCEEDED");
          const fallback = a.providerPolicy.fallbacks[0] ?? null;
          return (
            <Card key={a.id} className={cn("border-2", RING[a.status], isOrch && "md:col-span-2 xl:col-span-3")}>
              <CardHeader className="flex-wrap items-center">
                <div className="flex items-center gap-3">
                  <div className={cn("flex size-9 items-center justify-center rounded-md font-mono text-xs font-bold", isOrch ? "bg-ink text-white" : "bg-neutral-soft text-ink-2")}>
                    {isOrch ? <Crown className="size-4" /> : a.shortCode}
                  </div>
                  <div>
                    <div className="text-[14px] font-semibold text-ink">{a.name}</div>
                    <div className="text-xs text-muted">{a.role}</div>
                  </div>
                </div>
                <AgentStatusBadge status={a.status} detail={a.statusDetail} />
              </CardHeader>
              <CardContent className={cn("grid grid-cols-2 gap-3 text-xs", isOrch && "md:grid-cols-4")}>
                <Field label="Current project">
                  {project ? (
                    <Link to="/projects/$projectId" params={{ projectId: project.id }} className="text-accent hover:underline">
                      {project.name}
                    </Link>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </Field>
                <Field label="Current task">
                  {ticket ? (
                    <span>
                      <span className="font-mono text-[11px] text-muted">{ticket.code}</span> {ticket.title}
                    </span>
                  ) : isOrch && a.status === "WAITING_APPROVAL" ? (
                    <span>Awaiting human launch decision</span>
                  ) : (
                    <span className="text-faint">None</span>
                  )}
                </Field>
                <Field label="Last run">
                  {a.lastRunAt ? formatRelative(a.lastRunAt) : <span className="text-faint">not recorded</span>}
                  {lastRun ? <span className="text-muted"> · {PROVIDER_LABELS[lastRun.providerId]}</span> : null}
                </Field>
                <Field label="Outputs produced">
                  <span className="num font-medium">{a.outputsProduced}</span>
                </Field>
                <Field label="Preferred provider">
                  <NativeSelect className="h-7 text-xs" disabled={!canEdit} value={a.providerPolicy.preferred} onChange={(e) => actions.setAgentProvider(a.id, { preferred: e.target.value as ProviderId })}>
                    {PROVIDER_IDS.map((p) => (
                      <option key={p} value={p}>
                        {PROVIDER_LABELS[p]}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Fallback provider">
                  <NativeSelect
                    className="h-7 text-xs"
                    disabled={!canEdit}
                    value={fallback ?? ""}
                    onChange={(e) => {
                      const v = e.target.value as ProviderId | "";
                      const rest = a.providerPolicy.fallbacks.slice(1);
                      actions.setAgentProvider(a.id, { fallbacks: v ? [v, ...rest.filter((p) => p !== v)] : rest });
                    }}
                  >
                    <option value="">None</option>
                    {PROVIDER_IDS.filter((p) => p !== a.providerPolicy.preferred).map((p) => (
                      <option key={p} value={p}>
                        {PROVIDER_LABELS[p]}
                      </option>
                    ))}
                  </NativeSelect>
                  {a.providerPolicy.fallbacks.length > 1 ? <div className="mt-0.5 text-[11px] text-muted">then {a.providerPolicy.fallbacks.slice(1).map((p) => PROVIDER_LABELS[p]).join(", ")}</div> : null}
                  {a.providerPolicy.reviewer ? <div className="mt-0.5 text-[11px] text-muted">Reviewer: {PROVIDER_LABELS[a.providerPolicy.reviewer]}</div> : null}
                </Field>
                <Field label="Current availability">
                  <div className="flex flex-wrap gap-1">
                    {[a.providerPolicy.preferred, ...a.providerPolicy.fallbacks].map((p) => {
                      const st = providerState(p);
                      return (
                        <span key={p} className="inline-flex items-center gap-1 text-[11px]" title={st?.reason ?? undefined}>
                          <span className="text-muted">{PROVIDER_LABELS[p]}</span>
                          {st ? <ProviderStateBadge state={st.state} /> : <span className="text-faint">…</span>}
                        </span>
                      );
                    })}
                  </div>
                </Field>
                <Field label="Permission">
                  <span className={cn("rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-bold", a.permissionLevel === "GREEN" ? "border-ok/40 bg-ok-soft text-ok" : a.permissionLevel === "AMBER" ? "border-warn/40 bg-warn-soft text-warn" : "border-danger/40 bg-danger-soft text-danger")}>
                    {a.permissionLevel}
                  </span>
                  <span className="ml-1.5 text-[11px] text-muted">{a.canExecuteSiteChanges ? "may change sites (with approval)" : "never changes sites"}</span>
                </Field>
                <Field label="Produces">
                  <span className="text-[12px] text-ink-2">{a.producesArtifactTypes.map((t) => t.replace(/_/g, " ")).join(", ") || "—"}</span>
                </Field>
                <Field label="Capabilities">
                  <span className="text-[11px] text-ink-2">{a.requiredCapabilities.join(", ")}</span>
                </Field>
                <Field label="Priority">
                  <span className="text-[11px] text-ink-2">{a.defaultPriority ?? "BALANCED"}</span>
                </Field>
                {a.instructionPackIds?.length ? (
                  <Field label="Active skill">
                    <div className="flex flex-col gap-0.5">
                      {a.instructionPackIds.map((id) => {
                        const skill = data.skills.find((s) => s.id === id);
                        return skill ? (
                          <span key={id} className="text-[11px] text-ink-2">
                            {skill.name} <span className="font-mono text-[10px] text-muted">v{skill.version}</span> · {SKILL_STATUS_LABELS[skill.status]}
                          </span>
                        ) : null;
                      })}
                    </div>
                  </Field>
                ) : null}
                <div className={cn("col-span-2", isOrch && "md:col-span-4")}>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Responsibilities</div>
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {a.responsibilities.map((r) => (
                      <li key={r} className="rounded-sm border bg-canvas px-1.5 py-0.5 text-[11px] text-ink-2">
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <p className="mt-4 flex items-center gap-1.5 text-[11px] text-muted">
        <Bot className="size-3.5" /> Agent codes: ORCH, 01–08. Agent 08 (Intelligence Curator) only proposes lessons — see Knowledge. Real runs arrive when provider adapters are connected (see Settings).
      </p>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 text-[13px] text-ink">{children}</div>
    </div>
  );
}

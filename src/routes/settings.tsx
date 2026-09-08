import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionTitle } from "@/components/os/PageHeader";
import { SafetyPipeline } from "@/components/os/Pipeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { INTEGRATION_STATUS_LABELS } from "@/services/integrations";
import { KNOWLEDGE_SCOPES } from "@/services/knowledge";
import { PERMISSION_MODEL } from "@/data/state-machine";
import { useOS } from "@/state/os-store";
import { cn } from "@/lib/utils";
import { useGatewayHealth } from "@/gateway/useGatewayHealth";
import { ProviderStateBadge } from "@/components/os/status";
import { BookOpen, Cpu, Database, Plug, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

const TIER_CLS = {
  GREEN: "border-ok/40 bg-ok-soft text-ok",
  AMBER: "border-warn/40 bg-warn-soft text-warn",
  RED: "border-danger/40 bg-danger-soft text-danger",
};

function SettingsPage() {
  const { data, status } = useOS();
  const { health, error: healthError, loading: healthLoading } = useGatewayHealth();
  return (
    <>
      <PageHeader title="Settings" subtitle="Store, intelligence providers, integrations, safety doctrine and permission model." />

      <Card className="mb-5">
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div className="rounded-md border bg-canvas px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
              <Database className="size-3.5" /> Control plane
            </div>
            <p className="mt-1 text-xs text-ink-2">This dashboard. It records project state, tickets, approvals, holds, artifacts, jobs and knowledge. It never executes changes on a client site itself.</p>
            <div className="mt-2 text-[11px] text-muted">
              Store: <Badge tone={status.repositoryKind === "supabase" ? "ok" : "outline"}>{status.description}</Badge>
            </div>
            {status.reason ? <div className="mt-1 text-[11px] text-muted">{status.reason}</div> : null}
            {status.persistError ? <div className="mt-1 text-[11px] text-danger">Persist error: {status.persistError}</div> : null}
            {status.repositoryKind === "memory" ? <div className="mt-1 text-[11px] text-muted">To persist: apply supabase/migrations, then set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example).</div> : null}
          </div>
          <div className="rounded-md border bg-canvas px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
              <Cpu className="size-3.5" /> Intelligence providers
            </div>
            <p className="mt-1 text-xs text-ink-2">Agents keep their identity; the model behind them is a per-agent policy (preferred → fallback). Provider keys live only in the execution gateway.</p>
            <div className="mt-2 text-[11px] text-muted">
              Gateway: <Badge tone={status.gatewayKind === "http" ? "ok" : "outline"}>{status.gatewayKind === "http" ? "Server-side (Supabase)" : "Embedded — local mode, stubs only"}</Badge>
            </div>
            {healthLoading ? <div className="mt-2 text-[11px] text-muted">Checking providers…</div> : null}
            {healthError ? <div className="mt-2 text-[11px] text-danger">{healthError}</div> : null}
            {health ? (
              <ul className="mt-2 grid gap-1">
                {health.providers.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-ink">{p.label}</span>
                    <span className="flex items-center gap-1" title={p.reason ?? undefined}>
                      <ProviderStateBadge state={p.state} />
                      {p.state === "not_configured" ? <span className="font-mono text-[10px] text-faint">{p.envVar}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="rounded-md border bg-canvas px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
              <Plug className="size-3.5" /> Execution plane
            </div>
            <p className="mt-1 text-xs text-ink-2">External systems (WordPress, Cloudflare, Google, Meta, hosting) do the actual work, under the permission model below. Connected via adapters later.</p>
          </div>
        </CardContent>
      </Card>

      <SectionTitle>Integrations</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {data.integrations.map((i) => (
          <Card key={i.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <div className="text-[13px] font-semibold text-ink">{i.name}</div>
              <Badge tone={i.status === "CONFIGURED" ? "ok" : "neutral"}>
                <span className={cn("size-1.5 rounded-full", i.status === "CONFIGURED" ? "bg-ok" : "bg-faint")} />
                {INTEGRATION_STATUS_LABELS[i.status]}
              </Badge>
            </div>
            <div className="mt-1 text-xs text-muted">{i.purpose}</div>
            <div className="mt-2 text-[10px] uppercase tracking-wider text-faint">{i.plane} plane</div>
          </Card>
        ))}
      </div>

      <SectionTitle className="mt-6">Knowledge scopes</SectionTitle>
      <Card>
        <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {KNOWLEDGE_SCOPES.map((s) => (
            <div key={s.scope} className="rounded-md border bg-canvas px-3 py-2">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
                <BookOpen className="size-3.5 text-muted" /> {s.label}
              </div>
              <div className="mt-0.5 text-[11px] text-muted">{s.description}</div>
            </div>
          ))}
          <p className="text-[11px] text-muted sm:col-span-2 xl:col-span-4">Agents propose; humans approve. No agent can promote its own output into Agency or Doctrine knowledge.</p>
        </CardContent>
      </Card>

      <SectionTitle className="mt-6">Global safety doctrine</SectionTitle>
      <Card>
        <CardContent>
          <SafetyPipeline />
          <p className="mt-2 text-xs text-muted">Every build passes through two human gates. QA at zero is necessary, never sufficient, for launch.</p>
        </CardContent>
      </Card>

      <SectionTitle className="mt-6">Permission model (recorded on every job; enforcement arrives with the execution plane)</SectionTitle>
      <div className="grid gap-3 md:grid-cols-3">
        {PERMISSION_MODEL.map((tier) => (
          <Card key={tier.tier} className={cn("border-2", tier.tier === "GREEN" ? "border-ok/30" : tier.tier === "AMBER" ? "border-warn/30" : "border-danger/30")}>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <span className={cn("rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-bold", TIER_CLS[tier.tier])}>{tier.tier}</span>
                  {tier.label}
                </CardTitle>
                <p className="mt-0.5 text-xs text-muted">{tier.rule}</p>
              </div>
              <ShieldCheck className="size-4 text-faint" />
            </CardHeader>
            <CardContent>
              <ul className="grid gap-1">
                {tier.actions.map((a) => (
                  <li key={a} className="rounded-sm bg-canvas px-2 py-1 text-xs text-ink-2">
                    {a}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}


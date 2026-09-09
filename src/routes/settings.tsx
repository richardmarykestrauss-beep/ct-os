import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { PageHeader, SectionTitle } from "@/components/os/PageHeader";
import { SafetyPipeline } from "@/components/os/Pipeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { INTEGRATION_STATUS_LABELS } from "@/services/integrations";
import { KNOWLEDGE_SCOPES } from "@/services/knowledge";
import { EXTERNAL_CLIENT_TYPE_LABELS, EXTERNAL_CLIENT_STATUS_LABELS, EXTERNAL_CEILING_LABELS } from "@/services/external-clients";
import type { ExternalClientType, ExternalPermissionCeiling } from "@/data/types";
import { PERMISSION_MODEL } from "@/data/state-machine";
import { useOS } from "@/state/os-store";
import { cn } from "@/lib/utils";
import { useGatewayHealth } from "@/gateway/useGatewayHealth";
import { ProviderStateBadge } from "@/components/os/status";
import { BookOpen, Cpu, Database, Plug, ShieldCheck, History } from "lucide-react";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

const TIER_CLS = {
  GREEN: "border-ok/40 bg-ok-soft text-ok",
  AMBER: "border-warn/40 bg-warn-soft text-warn",
  RED: "border-danger/40 bg-danger-soft text-danger",
};

const CLIENT_STATUS_TONE: Record<string, "ok" | "neutral" | "danger"> = { ACTIVE: "ok", DISABLED: "neutral", REVOKED: "danger" };

function ExternalAssistantsSection() {
  const { data, user, actions } = useOS();
  const canManage = user.role === "ADMIN" || user.role === "PRODUCTION_LEAD";
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<ExternalClientType>("chatgpt");
  const [ceiling, setCeiling] = React.useState<ExternalPermissionCeiling>("READ_ONLY");
  const [revealToken, setRevealToken] = React.useState<{ clientName: string; rawToken: string } | null>(null);

  const clients = [...data.externalClients].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const recentAccess = [...data.externalAccessLog].reverse().slice(0, 50);
  const clientNameById = new Map(data.externalClients.map((c) => [c.id, c.name]));

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const { rawToken } = actions.createExternalClient({ name: name.trim(), type, permissionCeiling: ceiling });
    setRevealToken({ clientName: name.trim(), rawToken });
    setName("");
  };

  const rotate = (clientId: string, clientName: string) => {
    const { rawToken } = actions.rotateExternalClientToken(clientId);
    setRevealToken({ clientName, rawToken });
  };

  return (
    <>
      <SectionTitle className="mt-6">External assistants (MCP bridge — CTOS-004)</SectionTitle>
      <Card>
        <CardContent>
          <p className="text-xs text-muted">
            Outside assistants (ChatGPT, another Claude session, a future automation) reach CT-OS only through the MCP tool layer, never the database directly. Each identity below carries its own permission ceiling — Read only, or Read + GREEN writes — and every tool call it makes is written to the access history further down this page. See <span className="font-mono">docs/MCP-BRIDGE.md</span>.
          </p>

          {canManage ? (
            <form onSubmit={create} className="mt-3 grid gap-2 sm:grid-cols-[1fr_140px_180px_auto] sm:items-end">
              <div>
                <label className="text-[11px] font-medium text-muted">Name</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="chatgpt-richard" />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted">Type</label>
                <NativeSelect value={type} onChange={(e) => setType(e.target.value as ExternalClientType)}>
                  {Object.entries(EXTERNAL_CLIENT_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted">Permission ceiling</label>
                <NativeSelect value={ceiling} onChange={(e) => setCeiling(e.target.value as ExternalPermissionCeiling)}>
                  {Object.entries(EXTERNAL_CEILING_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <Button type="submit" size="sm">
                Register
              </Button>
            </form>
          ) : (
            <p className="mt-3 text-[11px] text-muted">Only Admin or Production Lead may register, enable/disable, rotate or revoke an external assistant identity.</p>
          )}

          <div className="mt-3">
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Type</TH>
                  <TH>Status</TH>
                  <TH>Permission ceiling</TH>
                  <TH>Allowed tools</TH>
                  <TH>Last used</TH>
                  {canManage ? <TH>Actions</TH> : null}
                </TR>
              </THead>
              <TBody>
                {clients.map((c) => (
                  <TR key={c.id}>
                    <TD className="font-medium text-ink">
                      {c.name} <span className="font-mono text-[10px] text-faint">{c.tokenPrefix ? `${c.tokenPrefix}…` : "revoked"}</span>
                    </TD>
                    <TD>{EXTERNAL_CLIENT_TYPE_LABELS[c.type]}</TD>
                    <TD>
                      <Badge tone={CLIENT_STATUS_TONE[c.status]}>{EXTERNAL_CLIENT_STATUS_LABELS[c.status]}</Badge>
                    </TD>
                    <TD>{EXTERNAL_CEILING_LABELS[c.permissionCeiling]}</TD>
                    <TD className="text-xs text-muted">{c.allowedTools ? c.allowedTools.join(", ") : "all tools its ceiling allows"}</TD>
                    <TD className="text-xs text-muted">{c.lastUsedAt ?? "never"}</TD>
                    {canManage ? (
                      <TD>
                        <div className="flex flex-wrap gap-1.5">
                          {c.status !== "REVOKED" ? (
                            <Button size="sm" variant="outline" onClick={() => actions.setExternalClientStatus(c.id, c.status === "ACTIVE" ? "DISABLED" : "ACTIVE")}>
                              {c.status === "ACTIVE" ? "Disable" : "Enable"}
                            </Button>
                          ) : null}
                          {c.status !== "REVOKED" ? (
                            <Button size="sm" variant="outline" onClick={() => rotate(c.id, c.name)}>
                              Rotate
                            </Button>
                          ) : null}
                          {c.status !== "REVOKED" ? (
                            <Button size="sm" variant="danger" onClick={() => actions.revokeExternalClient(c.id)}>
                              Revoke
                            </Button>
                          ) : null}
                        </div>
                      </TD>
                    ) : null}
                  </TR>
                ))}
                {clients.length === 0 ? (
                  <TR>
                    <TD colSpan={canManage ? 7 : 6} className="text-center text-xs text-muted">
                      No external assistant identities yet.
                    </TD>
                  </TR>
                ) : null}
              </TBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <SectionTitle className="mt-6">
        <span className="inline-flex items-center gap-1.5">
          <History className="size-3.5" /> External access history
        </span>
      </SectionTitle>
      <Card>
        <CardContent>
          <p className="text-xs text-muted">Every MCP tool call, whatever the outcome — this is the audit trail Part D/L of CTOS-004 require. Most recent 50 shown.</p>
          <div className="mt-3">
            <Table>
              <THead>
                <TR>
                  <TH>Time</TH>
                  <TH>External client</TH>
                  <TH>Tool</TH>
                  <TH>Project</TH>
                  <TH>Permission</TH>
                  <TH>Result</TH>
                </TR>
              </THead>
              <TBody>
                {recentAccess.map((e) => (
                  <TR key={e.id}>
                    <TD className="text-xs text-muted">{e.at ?? "—"}</TD>
                    <TD>{clientNameById.get(e.externalClientId) ?? e.externalClientName}</TD>
                    <TD className="font-mono text-xs">{e.tool}</TD>
                    <TD className="text-xs text-muted">{e.projectId ?? "—"}</TD>
                    <TD className="text-xs text-muted">{e.permissionTier ?? "—"}</TD>
                    <TD>
                      <Badge tone={e.result === "allowed" ? "ok" : e.result === "denied" ? "warn" : "danger"}>{e.result}</Badge>
                    </TD>
                  </TR>
                ))}
                {recentAccess.length === 0 ? (
                  <TR>
                    <TD colSpan={6} className="text-center text-xs text-muted">
                      No MCP calls recorded yet.
                    </TD>
                  </TR>
                ) : null}
              </TBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!revealToken} onOpenChange={(open) => !open && setRevealToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Credential for {revealToken?.clientName}</DialogTitle>
            <DialogDescription>Shown once. Copy it now — CT-OS stores only its hash and never displays it again. Put it in that assistant's MCP config as CTOS_MCP_TOKEN.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <code className="block break-all rounded-md border bg-canvas px-3 py-2 text-[12px] text-ink">{revealToken?.rawToken}</code>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button size="sm">Done</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

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

      <ExternalAssistantsSection />
    </>
  );
}

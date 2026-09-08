import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  CheckSquare,
  ClipboardCheck,
  BookOpen,
  Bot,
  Building2,
  FolderKanban,
  LayoutDashboard,
  ListOrdered,
  LogOut,
  Menu,
  Settings,
  X,
} from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { useOS } from "@/state/os-store";
import { useAuth } from "@/auth/AuthProvider";
import { ROLE_LABELS } from "@/auth/backend";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/projects", label: "Projects", icon: FolderKanban },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/build-queue", label: "Build Queue", icon: ListOrdered },
  { to: "/qa", label: "QA", icon: ClipboardCheck },
  { to: "/approvals", label: "Approvals", icon: CheckSquare },
  { to: "/clients", label: "Clients", icon: Building2 },
  { to: "/knowledge", label: "Knowledge", icon: BookOpen },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppSidebar() {
  const [open, setOpen] = React.useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data, status, user } = useOS();
  const auth = useAuth();
  const pendingApprovals = data.approvals.filter((a) => a.status === "PENDING").length + data.tickets.filter((t) => t.approvalState === "PENDING").length + data.jobApprovals.filter((a) => a.status === "PENDING").length;
  const knowledgeCandidates = data.knowledgeItems.filter((k) => k.status === "CANDIDATE").length;

  React.useEffect(() => setOpen(false), [pathname]);

  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5 px-2 py-2">
      {NAV.map((item) => {
        const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
        const Icon = item.icon;
        const badge = item.to === "/approvals" && pendingApprovals > 0 ? pendingApprovals : item.to === "/knowledge" && knowledgeCandidates > 0 ? knowledgeCandidates : null;
        return (
          <Link
            key={item.to}
            to={item.to}
            className={cn(
              "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-side-muted transition-colors hover:bg-side-2 hover:text-side-ink",
              active && "bg-side-2 text-white",
            )}
          >
            <Icon className={cn("size-4 shrink-0", active ? "text-accent" : "text-side-muted group-hover:text-side-ink")} />
            <span className="flex-1">{item.label}</span>
            {badge ? <span className={cn("rounded-sm px-1.5 text-[10px] font-semibold text-white", item.to === "/knowledge" ? "bg-hold" : "bg-warn")}>{badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );

  const footer = (
    <div className="border-t border-side-border px-3 py-3">
      <div className="flex items-center gap-2.5">
        <div className="flex size-7 items-center justify-center rounded-md bg-side-2 text-[11px] font-semibold text-side-ink">{initials(user.displayName)}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-side-ink">{user.displayName}</div>
          <div className="truncate text-[11px] text-side-muted">
            {ROLE_LABELS[user.role]}
            {auth.kind === "local" ? " · local mode" : ""}
          </div>
        </div>
        <button aria-label="Sign out" title="Sign out" onClick={() => void auth.signOut()} className="rounded-md p-1.5 text-side-muted hover:bg-side-2 hover:text-side-ink">
          <LogOut className="size-3.5" />
        </button>
      </div>
      <div className="mt-3 flex items-center justify-between rounded-md bg-side-2 px-2.5 py-1.5 text-[11px]">
        <span className="flex items-center gap-1.5 text-side-muted">
          <Activity className="size-3" /> System
        </span>
        <span className="flex items-center gap-1.5 font-medium text-side-ink">
          <span className="size-1.5 rounded-full bg-ok" /> Operational
        </span>
      </div>
      <div className="mt-1.5 px-0.5 text-[10px] text-side-muted">
        Store: {status.repositoryKind === "supabase" ? "Supabase" : "in-memory"} · Gateway: {status.gatewayKind === "http" ? "server" : "embedded"}
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile top bar */}
      <div className="flex h-12 items-center justify-between border-b border-side-border bg-side px-3 lg:hidden">
        <Brand />
        <button aria-label="Toggle navigation" onClick={() => setOpen((o) => !o)} className="rounded-md p-1.5 text-side-ink hover:bg-side-2">
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-side">
            <div className="flex h-12 items-center border-b border-side-border px-4">
              <Brand />
            </div>
            {nav}
            {footer}
          </aside>
        </div>
      ) : null}
      {/* Desktop sidebar */}
      <aside className="hidden w-[232px] shrink-0 flex-col border-r border-side-border bg-side lg:flex">
        <div className="flex h-14 items-center border-b border-side-border px-4">
          <Brand />
        </div>
        {nav}
        {footer}
      </aside>
    </>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "CT";
}

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <div className="flex size-7 items-center justify-center rounded-md bg-accent text-[12px] font-bold text-white">CT</div>
      <div className="leading-tight">
        <div className="text-[13px] font-semibold text-white">Website OS</div>
        <div className="text-[10px] uppercase tracking-wider text-side-muted">Creative Touch</div>
      </div>
    </Link>
  );
}

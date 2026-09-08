/**
 * Status primitives — every badge/pill in the OS maps a domain status to a tone here,
 * so colour semantics stay consistent across screens.
 */
import { Badge, type BadgeProps } from "@/components/ui/badge";
import type {
  AgentStatus,
  ApprovalStatus,
  BuildStatus,
  PhaseStatus,
  ProjectState,
  QASeverity,
  QAItemStatus,
  QAStatus,
  TicketApprovalState,
  TicketStatus,
} from "@/data/types";
import { AGENT_STATUS_LABELS, PROJECT_STATE_LABELS, TICKET_STATUS_LABELS } from "@/data/state-machine";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Circle, CircleDashed, Clock, Loader2, PauseCircle, ShieldAlert } from "lucide-react";

type Tone = NonNullable<BadgeProps["tone"]>;

export const PROJECT_STATE_TONE: Record<ProjectState, Tone> = {
  NEW: "neutral",
  DISCOVERY: "info",
  STRATEGY: "info",
  DESIGN: "info",
  CONTENT: "info",
  READY_TO_BUILD: "accent",
  BUILDING: "accent",
  QA: "warn",
  READY_TO_LAUNCH: "hold",
  LIVE: "ok",
  MAINTENANCE: "ok",
  ARCHIVED: "neutral",
};

export function ProjectStateBadge({ state, className }: { state: ProjectState; className?: string }) {
  return (
    <Badge tone={PROJECT_STATE_TONE[state]} className={className}>
      {PROJECT_STATE_LABELS[state]}
    </Badge>
  );
}

/** Operational status label e.g. "BUILD COMPLETE / HUMAN REVIEW" */
export function StatusLabel({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded-sm border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-wide text-ink", className)}>
      {label}
    </span>
  );
}

const AGENT_TONE: Record<AgentStatus, Tone> = { IDLE: "neutral", WORKING: "accent", WAITING_APPROVAL: "warn", BLOCKED: "danger" };

export function AgentStatusBadge({ status, detail }: { status: AgentStatus; detail?: string }) {
  const Icon = status === "WORKING" ? Loader2 : status === "WAITING_APPROVAL" ? Clock : status === "BLOCKED" ? ShieldAlert : Circle;
  return (
    <Badge tone={AGENT_TONE[status]}>
      <Icon className={cn("size-3", status === "WORKING" && "animate-spin")} />
      {AGENT_STATUS_LABELS[status]}
      {detail ? <span className="opacity-70">· {detail}</span> : null}
    </Badge>
  );
}

const TICKET_TONE: Record<TicketStatus, Tone> = { QUEUED: "neutral", READY: "info", BUILDING: "accent", REVIEW: "warn", COMPLETE: "ok", BLOCKED: "danger" };

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <Badge tone={TICKET_TONE[status]}>{TICKET_STATUS_LABELS[status]}</Badge>;
}

const BUILD_TONE: Record<BuildStatus, Tone> = { QUEUED: "neutral", BUILDING: "accent", COMPLETE: "ok", SUPERSEDED: "outline" };
const BUILD_LABEL: Record<BuildStatus, string> = { QUEUED: "Queued", BUILDING: "Building", COMPLETE: "Build Complete", SUPERSEDED: "Superseded" };

export function BuildStatusBadge({ status }: { status: BuildStatus }) {
  return <Badge tone={BUILD_TONE[status]}>{BUILD_LABEL[status]}</Badge>;
}

const QA_TONE: Record<QAStatus, Tone> = { NOT_RUN: "neutral", IN_QA: "warn", PASS: "ok", FAIL: "danger" };
const QA_LABEL: Record<QAStatus, string> = { NOT_RUN: "Not run", IN_QA: "In QA", PASS: "QA Pass", FAIL: "QA Fail" };

export function QAStatusBadge({ status }: { status: QAStatus }) {
  return <Badge tone={QA_TONE[status]}>{QA_LABEL[status]}</Badge>;
}

const SEV_TONE: Record<QASeverity, Tone> = { P0: "danger", P1: "warn", P2: "info", P3: "neutral" };

export function SeverityBadge({ severity }: { severity: QASeverity }) {
  return (
    <Badge tone={SEV_TONE[severity]} className="font-mono">
      {severity}
    </Badge>
  );
}

const QA_ITEM_TONE: Record<QAItemStatus, Tone> = { OPEN: "danger", IN_PROGRESS: "accent", FIXED: "info", VERIFIED: "ok", WONT_FIX: "neutral" };
const QA_ITEM_LABEL: Record<QAItemStatus, string> = { OPEN: "Open", IN_PROGRESS: "In progress", FIXED: "Fixed", VERIFIED: "Verified", WONT_FIX: "Won't fix" };

export function QAItemStatusBadge({ status }: { status: QAItemStatus }) {
  return <Badge tone={QA_ITEM_TONE[status]}>{QA_ITEM_LABEL[status]}</Badge>;
}

const APPROVAL_TONE: Record<ApprovalStatus, Tone> = { PENDING: "warn", APPROVED: "ok", CHANGES_REQUESTED: "danger" };
const APPROVAL_LABEL: Record<ApprovalStatus, string> = { PENDING: "Pending", APPROVED: "Approved", CHANGES_REQUESTED: "Changes Requested" };

export function ApprovalStatusBadge({ status }: { status: ApprovalStatus }) {
  const Icon = status === "APPROVED" ? CheckCircle2 : status === "PENDING" ? Clock : AlertTriangle;
  return (
    <Badge tone={APPROVAL_TONE[status]}>
      <Icon className="size-3" />
      {APPROVAL_LABEL[status]}
    </Badge>
  );
}

const TICKET_APPROVAL_TONE: Record<TicketApprovalState, Tone> = { NOT_REQUIRED: "neutral", PENDING: "warn", APPROVED: "ok", NEEDS_REVISION: "danger" };
const TICKET_APPROVAL_LABEL: Record<TicketApprovalState, string> = { NOT_REQUIRED: "Not required", PENDING: "Pending", APPROVED: "Approved", NEEDS_REVISION: "Needs revision" };

export function TicketApprovalBadge({ state }: { state: TicketApprovalState }) {
  return <Badge tone={TICKET_APPROVAL_TONE[state]}>{TICKET_APPROVAL_LABEL[state]}</Badge>;
}

const PROVIDER_STATE: Record<"connected" | "not_configured" | "stub", { tone: Tone; label: string }> = {
  connected: { tone: "ok", label: "Connected" },
  not_configured: { tone: "neutral", label: "Not configured" },
  stub: { tone: "outline", label: "Stub" },
};

const TIER_CLS: Record<"GREEN" | "AMBER" | "RED", string> = {
  GREEN: "border-ok/40 bg-ok-soft text-ok",
  AMBER: "border-warn/40 bg-warn-soft text-warn",
  RED: "border-danger/40 bg-danger-soft text-danger",
};

export function PermissionTierBadge({ tier }: { tier: "GREEN" | "AMBER" | "RED" }) {
  return <span className={cn("inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-bold", TIER_CLS[tier])}>{tier}</span>;
}

export function ProviderStateBadge({ state }: { state: "connected" | "not_configured" | "stub" }) {
  const s = PROVIDER_STATE[state];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function HoldBadge({ label = "Hold" }: { label?: string }) {
  return (
    <Badge tone="hold">
      <PauseCircle className="size-3" />
      {label}
    </Badge>
  );
}

export function WarningBadge({ count }: { count: number }) {
  if (!count) return <span className="text-faint">—</span>;
  return (
    <Badge tone="warn">
      <AlertTriangle className="size-3" />
      {count}
    </Badge>
  );
}

/** Phase dot used by the pipeline visualisation. */
export function PhaseStatusIcon({ status, className }: { status: PhaseStatus; className?: string }) {
  const base = cn("size-4", className);
  switch (status) {
    case "COMPLETE":
      return <CheckCircle2 className={cn(base, "text-ok")} />;
    case "IN_PROGRESS":
      return <Loader2 className={cn(base, "text-accent animate-spin")} />;
    case "PENDING_HOLDS":
      return <PauseCircle className={cn(base, "text-hold")} />;
    case "BLOCKED":
      return <ShieldAlert className={cn(base, "text-danger")} />;
    default:
      return <CircleDashed className={cn(base, "text-faint")} />;
  }
}

export const PHASE_STATUS_LABEL: Record<PhaseStatus, string> = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  COMPLETE: "Complete",
  PENDING_HOLDS: "Pending Holds",
  BLOCKED: "Blocked",
};

import type { ProjectState, ProjectType, PhaseKey, AgentStatus, TicketStatus, ApprovalGate } from "./types";

export const PROJECT_STATES: ProjectState[] = [
  "NEW",
  "DISCOVERY",
  "STRATEGY",
  "DESIGN",
  "CONTENT",
  "READY_TO_BUILD",
  "BUILDING",
  "QA",
  "READY_TO_LAUNCH",
  "LIVE",
  "MAINTENANCE",
  "ARCHIVED",
];

export const PROJECT_STATE_LABELS: Record<ProjectState, string> = {
  NEW: "New",
  DISCOVERY: "Discovery",
  STRATEGY: "Strategy",
  DESIGN: "Design",
  CONTENT: "Content",
  READY_TO_BUILD: "Ready to Build",
  BUILDING: "Building",
  QA: "QA",
  READY_TO_LAUNCH: "Ready to Launch",
  LIVE: "Live",
  MAINTENANCE: "Maintenance",
  ARCHIVED: "Archived",
};

/** Forward flow, plus explicit backward transitions. ARCHIVED is reachable from any sensible state. */
const NEXT: Partial<Record<ProjectState, ProjectState>> = {
  NEW: "DISCOVERY",
  DISCOVERY: "STRATEGY",
  STRATEGY: "DESIGN",
  DESIGN: "CONTENT",
  CONTENT: "READY_TO_BUILD",
  READY_TO_BUILD: "BUILDING",
  BUILDING: "QA",
  QA: "READY_TO_LAUNCH",
  READY_TO_LAUNCH: "LIVE",
  LIVE: "MAINTENANCE",
};

const BACKWARD: Partial<Record<ProjectState, ProjectState[]>> = {
  QA: ["BUILDING"],
  READY_TO_LAUNCH: ["QA"],
};

export function nextState(state: ProjectState): ProjectState | null {
  return NEXT[state] ?? null;
}

export function allowedTransitions(state: ProjectState): ProjectState[] {
  const out: ProjectState[] = [];
  const n = NEXT[state];
  if (n) out.push(n);
  for (const b of BACKWARD[state] ?? []) out.push(b);
  if (state !== "ARCHIVED") out.push("ARCHIVED");
  return out;
}

export function canTransition(from: ProjectState, to: ProjectState): boolean {
  return allowedTransitions(from).includes(to);
}

/** Approximate production progress for a state — used only for new projects; U-Proof carries its own value. */
export const STATE_PROGRESS: Record<ProjectState, number> = {
  NEW: 0,
  DISCOVERY: 8,
  STRATEGY: 18,
  DESIGN: 30,
  CONTENT: 42,
  READY_TO_BUILD: 50,
  BUILDING: 65,
  QA: 80,
  READY_TO_LAUNCH: 92,
  LIVE: 100,
  MAINTENANCE: 100,
  ARCHIVED: 100,
};

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  NEW_WEBSITE: "New Website",
  WEBSITE_REBUILD: "Website Rebuild",
  ECOMMERCE_BUILD: "Ecommerce Build",
  ECOMMERCE_REBUILD: "Ecommerce Rebuild",
  MIGRATION: "Migration",
  LANDING_PAGE: "Landing Page",
  MAINTENANCE_ONBOARDING: "Maintenance Onboarding",
};

export const PHASES: { key: PhaseKey; label: string; short: string }[] = [
  { key: "DISCOVERY", label: "Discovery", short: "Discovery" },
  { key: "UX", label: "UX Architecture", short: "UX" },
  { key: "CREATIVE", label: "Creative Direction", short: "Creative" },
  { key: "CONTENT", label: "SEO & Content", short: "Content" },
  { key: "BUILD", label: "Elementor Build", short: "Build" },
  { key: "QA", label: "QA", short: "QA" },
  { key: "LAUNCH", label: "Migration / Launch", short: "Launch" },
];

export const PHASE_LABELS: Record<PhaseKey, string> = Object.fromEntries(PHASES.map((p) => [p.key, p.label])) as Record<PhaseKey, string>;

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  IDLE: "Idle",
  WORKING: "Working",
  WAITING_APPROVAL: "Waiting Approval",
  BLOCKED: "Blocked",
};

export const TICKET_STATUSES: TicketStatus[] = ["QUEUED", "READY", "BUILDING", "REVIEW", "COMPLETE", "BLOCKED"];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  QUEUED: "Queued",
  READY: "Ready",
  BUILDING: "Building",
  REVIEW: "Review",
  COMPLETE: "Complete",
  BLOCKED: "Blocked",
};

export const APPROVAL_GATE_LABELS: Record<ApprovalGate, string> = {
  STRATEGY: "Strategy",
  DESIGN: "Design",
  STAGING_BUILD: "Staging Build",
  LAUNCH: "Launch",
};

/** Global safety doctrine — displayed in the UI, enforced later by the execution plane. */
export const SAFETY_PIPELINE = [
  "BUILD",
  "PREVIEW",
  "HUMAN DESIGN APPROVAL",
  "QA",
  "FINAL REGRESSION AUDIT",
  "CONTROLLED ACTIVATION TESTING",
  "HUMAN LAUNCH APPROVAL",
  "LIVE",
] as const;

export type PermissionTier = "GREEN" | "AMBER" | "RED";

export const PERMISSION_MODEL: { tier: PermissionTier; label: string; rule: string; actions: string[] }[] = [
  {
    tier: "GREEN",
    label: "Automatic",
    rule: "Agents may run without approval.",
    actions: ["Research", "Draft copy", "SEO analysis", "Image generation", "Reports", "Draft pages", "QA"],
  },
  {
    tier: "AMBER",
    label: "Human approval",
    rule: "Requires an explicit human approval before execution.",
    actions: ["Publish", "Plugin installation", "Site-wide CSS", "Redirects", "Menus", "Woo settings", "Tracking code", "Template assignment"],
  },
  {
    tier: "RED",
    label: "Never automatic",
    rule: "Never executed by an agent without explicit, named authorization.",
    actions: [
      "DNS nameservers",
      "Registrar ownership",
      "Payment credentials",
      "Production database deletion",
      "Site deletion",
      "Removing users",
      "Destructive infrastructure",
    ],
  },
];

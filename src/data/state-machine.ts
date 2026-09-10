import type { ProjectState, ProjectType, PhaseKey, AgentStatus, TicketStatus, ApprovalGate } from "./types";

export const PROJECT_STATES: ProjectState[] = [
  "NEW",
  "DISCOVERY",
  "STRATEGY",
  "DESIGN",
  "CONTENT",
  "DESIGN_AND_CONTENT",
  "READY_TO_BUILD",
  "BUILDING",
  "QA",
  "CLIENT_REVIEW",
  "READY_TO_LAUNCH",
  "LIVE",
  "MAINTENANCE",
  "ARCHIVED",
];

export const PROJECT_STATE_LABELS: Record<ProjectState, string> = {
  NEW: "New",
  DISCOVERY: "Discovery",
  STRATEGY: "Strategy",
  // Legacy sequential states preserved for backward compatibility with existing projects.
  DESIGN: "Design",
  CONTENT: "Content",
  // Workflow V1 concurrent state (CTOS-005A Part 4).
  // Subtracks tracked via project.designComplete / project.contentComplete flags on the Project.
  DESIGN_AND_CONTENT: "Design + Content",
  READY_TO_BUILD: "Ready to Build",
  BUILDING: "Building",
  QA: "QA",
  CLIENT_REVIEW: "Client Review",
  READY_TO_LAUNCH: "Ready to Launch",
  LIVE: "Live",
  MAINTENANCE: "Maintenance",
  ARCHIVED: "Archived",
};

/**
 * Forward flow for Workflow V1 (CTOS-005A Part 3).
 * DESIGN and CONTENT legacy states forward to DESIGN_AND_CONTENT (additive migration path).
 * CLIENT_REVIEW is a new explicit gate before READY_TO_LAUNCH.
 */
const NEXT: Partial<Record<ProjectState, ProjectState>> = {
  NEW: "DISCOVERY",
  DISCOVERY: "STRATEGY",
  // Legacy path: sequential design then content (kept for historical projects)
  STRATEGY: "DESIGN_AND_CONTENT",
  DESIGN: "DESIGN_AND_CONTENT",
  CONTENT: "READY_TO_BUILD",
  // Workflow V1 path: concurrent design+content → ready to build
  DESIGN_AND_CONTENT: "READY_TO_BUILD",
  READY_TO_BUILD: "BUILDING",
  BUILDING: "QA",
  QA: "CLIENT_REVIEW",
  CLIENT_REVIEW: "READY_TO_LAUNCH",
  READY_TO_LAUNCH: "LIVE",
  LIVE: "MAINTENANCE",
};

const BACKWARD: Partial<Record<ProjectState, ProjectState[]>> = {
  QA: ["BUILDING"],
  CLIENT_REVIEW: ["QA"],
  READY_TO_LAUNCH: ["CLIENT_REVIEW", "QA"],
  // Allow returning to design+content from ready_to_build when approved artifacts need revision
  READY_TO_BUILD: ["DESIGN_AND_CONTENT"],
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
  CONTENT: 40,
  DESIGN_AND_CONTENT: 35,
  READY_TO_BUILD: 50,
  BUILDING: 65,
  QA: 78,
  CLIENT_REVIEW: 85,
  READY_TO_LAUNCH: 92,
  LIVE: 100,
  MAINTENANCE: 100,
  ARCHIVED: 100,
};

/**
 * Workflow V1 stage labels (informational — the state machine is still the authority).
 * Used in UI and reporting to orient the operator without exposing implementation details.
 */
export const WORKFLOW_STAGE_LABELS: Record<number, string> = {
  0: "Intake",
  1: "Discovery",
  2: "Architecture + Direction",
  3: "Design + Content",
  4: "Build",
  5: "Client Review",
  6: "Launch",
  7: "Maintenance + Learning",
};

/**
 * Maps project states to the corresponding Workflow V1 stage (CTOS-005A Part 3).
 * Stages are informational; the state machine transitions remain the authority.
 */
export const STATE_TO_WORKFLOW_STAGE: Partial<Record<ProjectState, number>> = {
  NEW: 0,
  DISCOVERY: 1,
  STRATEGY: 2,
  DESIGN: 3,
  CONTENT: 3,
  DESIGN_AND_CONTENT: 3,
  READY_TO_BUILD: 3,
  BUILDING: 4,
  QA: 4,
  CLIENT_REVIEW: 5,
  READY_TO_LAUNCH: 6,
  LIVE: 7,
  MAINTENANCE: 7,
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

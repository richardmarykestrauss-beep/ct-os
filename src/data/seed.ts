/**
 * Seed data — U-Proof is the first REAL project.
 *
 * Rules:
 *  - No invented historical dates. Where the exact time is unknown the field is `null`
 *    and the UI orders by ticket sequence instead.
 *  - Launch holds are modelled separately from QA defects.
 *  - Artifacts are metadata records only (storageRef = null) — no files are claimed to exist.
 */
import type {
  Agent,
  AgentLesson,
  Approval,
  Artifact,
  ActivityEvent,
  Client,
  GateDefinition,
  Integration,
  KnowledgeItem,
  LaunchHold,
  OSData,
  Project,
  ProjectPage,
  ProjectPhase,
  QAItem,
  QARun,
  Ticket,
} from "./types";

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------
export const CLIENT_UPROOF = "client_uproof";
export const PROJECT_UPROOF = "proj_uproof";

export const AGENT_IDS = {
  ORCH: "agent_orch",
  A01: "agent_01",
  A02: "agent_02",
  A03: "agent_03",
  A04: "agent_04",
  A05: "agent_05",
  A06: "agent_06",
  A07: "agent_07",
  A08: "agent_08",
} as const;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const clients: Client[] = [
  {
    id: CLIENT_UPROOF,
    name: "U-Proof",
    websiteUrl: "https://uproof.co.za",
    notes: "Waterproofing products. Ecommerce rebuild on WordPress + Elementor Pro + WooCommerce.",
    createdAt: null,
  },
];

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
const projects: Project[] = [
  {
    id: PROJECT_UPROOF,
    clientId: CLIENT_UPROOF,
    name: "U-Proof",
    type: "ECOMMERCE_REBUILD",
    platforms: ["WordPress", "Elementor Pro", "WooCommerce"],
    platformSummary: "WordPress + Elementor Pro + WooCommerce",
    domain: "https://uproof.co.za",
    state: "READY_TO_LAUNCH",
    statusLabel: "BUILD COMPLETE / HUMAN REVIEW",
    progress: 90,
    progressNote: "Approximate production progress — not a mathematically precise figure.",
    currentPhase: "Final QA / Activation Readiness",
    nextAction: "Human review and controlled activation testing",
    primaryGoal: "Rebuild the U-Proof ecommerce site on a portable WordPress + Elementor Pro + WooCommerce stack.",
    hasExistingWebsite: true,
    createdAt: null,
    updatedAt: null,
  },
];

// ---------------------------------------------------------------------------
// Pipeline phases
// ---------------------------------------------------------------------------
const phases: ProjectPhase[] = [
  { id: "ph_up_1", projectId: PROJECT_UPROOF, key: "DISCOVERY", label: "Discovery", status: "COMPLETE", order: 1 },
  { id: "ph_up_2", projectId: PROJECT_UPROOF, key: "UX", label: "UX Architecture", status: "COMPLETE", order: 2 },
  { id: "ph_up_3", projectId: PROJECT_UPROOF, key: "CREATIVE", label: "Creative Direction", status: "COMPLETE", order: 3 },
  { id: "ph_up_4", projectId: PROJECT_UPROOF, key: "CONTENT", label: "SEO & Content", status: "COMPLETE", order: 4 },
  { id: "ph_up_5", projectId: PROJECT_UPROOF, key: "BUILD", label: "Elementor Build", status: "COMPLETE", order: 5 },
  { id: "ph_up_6", projectId: PROJECT_UPROOF, key: "QA", label: "QA", status: "COMPLETE", order: 6 },
  {
    id: "ph_up_7",
    projectId: PROJECT_UPROOF,
    key: "LAUNCH",
    label: "Migration / Launch",
    status: "PENDING_HOLDS",
    order: 7,
    note: "Pending launch holds and human launch approval",
  },
];

// ---------------------------------------------------------------------------
// Agents — identities are stable; providers are a replaceable policy per agent.
// ---------------------------------------------------------------------------
type AgentSeed = Omit<Agent, "createdAt" | "updatedAt" | "lastRunAt" | "currentProjectId" | "currentTicketId" | "statusDetail"> &
  Partial<Pick<Agent, "statusDetail" | "currentProjectId" | "currentTicketId">>;

function agent(seed: AgentSeed): Agent {
  return { currentProjectId: null, currentTicketId: null, lastRunAt: null, createdAt: null, updatedAt: null, ...seed };
}

const agents: Agent[] = [
  agent({
    id: AGENT_IDS.ORCH,
    code: "ORCH",
    shortCode: "ORCH",
    name: "Orchestrator",
    role: "Workflow coordination & human approval gates",
    responsibilities: ["Coordinates the complete workflow", "Routes work to specialist agents", "Enforces human approval gates"],
    status: "WAITING_APPROVAL",
    statusDetail: "Human Review",
    currentProjectId: PROJECT_UPROOF,
    outputsProduced: 0,
    providerPolicy: { preferred: "claude", fallbacks: ["openai"], reviewer: null },
    permissionLevel: "AMBER",
    requiredCapabilities: ["text", "structured_output", "long_context"],
    producesArtifactTypes: ["project_brief", "build_plan"],
    consumesArtifactTypes: ["research_report", "site_blueprint", "design_system", "content_pack", "build_report", "qa_report", "client_feedback"],
    canExecuteSiteChanges: false,
  }),
  agent({
    id: AGENT_IDS.A01,
    code: "A01",
    shortCode: "01",
    name: "Research & Discovery",
    role: "Business, site and competitor intelligence",
    responsibilities: ["Business analysis", "Existing-site audit", "Competitor intelligence"],
    status: "IDLE",
    outputsProduced: 1,
    providerPolicy: { preferred: "gemini", fallbacks: ["claude", "openai"], reviewer: null },
    permissionLevel: "GREEN",
    requiredCapabilities: ["text", "structured_output", "long_context"],
    producesArtifactTypes: ["research_report"],
    consumesArtifactTypes: ["project_brief", "client_feedback"],
    canExecuteSiteChanges: false,
  }),
  agent({
    id: AGENT_IDS.A02,
    code: "A02",
    shortCode: "02",
    name: "UX & Conversion Architect",
    role: "Sitemap, customer journey, IA, conversion logic",
    responsibilities: ["Sitemap", "Customer journey", "Information architecture", "Conversion logic"],
    status: "IDLE",
    outputsProduced: 1,
    providerPolicy: { preferred: "claude", fallbacks: ["openai"], reviewer: "gemini" },
    permissionLevel: "GREEN",
    requiredCapabilities: ["text", "structured_output"],
    producesArtifactTypes: ["site_blueprint"],
    consumesArtifactTypes: ["research_report", "project_brief", "client_feedback"],
    canExecuteSiteChanges: false,
  }),
  agent({
    id: AGENT_IDS.A03,
    code: "A03",
    shortCode: "03",
    name: "Creative Director",
    role: "Visual direction, layout system, design tokens, imagery",
    responsibilities: ["Visual direction", "Layout system", "Design tokens", "Imagery direction"],
    status: "IDLE",
    outputsProduced: 1,
    providerPolicy: { preferred: "claude", fallbacks: ["openai", "gemini"], reviewer: null },
    permissionLevel: "GREEN",
    requiredCapabilities: ["text", "structured_output", "vision"],
    producesArtifactTypes: ["design_system"],
    consumesArtifactTypes: ["site_blueprint", "research_report", "client_feedback"],
    canExecuteSiteChanges: false,
  }),
  agent({
    id: AGENT_IDS.A04,
    code: "A04",
    shortCode: "04",
    name: "SEO & Content Architect",
    role: "SEO architecture, page copy, metadata, internal linking",
    responsibilities: ["SEO architecture", "Page copy", "Metadata", "Internal linking", "Content mapping"],
    status: "IDLE",
    outputsProduced: 1,
    providerPolicy: { preferred: "claude", fallbacks: ["openai"], reviewer: null },
    permissionLevel: "GREEN",
    requiredCapabilities: ["text", "structured_output", "long_context"],
    producesArtifactTypes: ["content_pack"],
    consumesArtifactTypes: ["site_blueprint", "design_system", "research_report"],
    canExecuteSiteChanges: false,
  }),
  agent({
    id: AGENT_IDS.A05,
    code: "A05",
    shortCode: "05",
    name: "WordPress / Elementor Builder",
    role: "Technical implementation",
    responsibilities: ["Elementor global design system", "Templates & pages", "WooCommerce configuration", "Build reports"],
    status: "IDLE",
    outputsProduced: 16,
    providerPolicy: { preferred: "claude", fallbacks: ["openai"], reviewer: null },
    permissionLevel: "AMBER",
    requiredCapabilities: ["text", "structured_output", "code"],
    producesArtifactTypes: ["build_report"],
    consumesArtifactTypes: ["build_plan", "design_system", "content_pack", "site_blueprint", "qa_report"],
    canExecuteSiteChanges: true,
  }),
  agent({
    id: AGENT_IDS.A06,
    code: "A06",
    shortCode: "06",
    name: "QA & Launch Auditor",
    role: "Independent testing, regression audit, launch readiness",
    responsibilities: ["Whole-site QA", "Regression audit", "Launch readiness"],
    status: "IDLE",
    outputsProduced: 2,
    providerPolicy: { preferred: "openai", fallbacks: ["claude", "gemini"], reviewer: null },
    permissionLevel: "GREEN",
    requiredCapabilities: ["text", "structured_output", "vision", "review"],
    producesArtifactTypes: ["qa_report"],
    consumesArtifactTypes: ["build_report", "site_blueprint", "design_system", "content_pack"],
    canExecuteSiteChanges: false,
  }),
  agent({
    id: AGENT_IDS.A07,
    code: "A07",
    shortCode: "07",
    name: "Infrastructure & Deployment",
    role: "Hosting, DNS, backups, migration and controlled activation",
    responsibilities: ["Hosting & environments", "Backups before mutation", "DNS / SSL readiness", "Migration & activation runbooks", "Deployment reports"],
    status: "IDLE",
    outputsProduced: 0,
    providerPolicy: { preferred: "claude", fallbacks: ["openai"], reviewer: null },
    permissionLevel: "AMBER",
    requiredCapabilities: ["text", "structured_output", "code"],
    producesArtifactTypes: ["deployment_report"],
    consumesArtifactTypes: ["qa_report", "build_report"],
    canExecuteSiteChanges: true,
  }),
  agent({
    id: AGENT_IDS.A08,
    code: "A08",
    shortCode: "08",
    name: "Intelligence Curator",
    role: "Reviews evidence and proposes lesson candidates — never builds",
    responsibilities: ["Review client feedback", "Review QA defects", "Identify successful & failed patterns", "Review performance & conversion evidence", "Propose lesson candidates"],
    status: "IDLE",
    outputsProduced: 0,
    providerPolicy: { preferred: "claude", fallbacks: ["gemini", "openai"], reviewer: null },
    permissionLevel: "GREEN",
    requiredCapabilities: ["text", "structured_output", "long_context", "review"],
    producesArtifactTypes: ["lesson_candidate"],
    consumesArtifactTypes: ["qa_report", "client_feedback", "build_report", "deployment_report", "research_report"],
    canExecuteSiteChanges: false,
  }),
];

// ---------------------------------------------------------------------------
// Tickets (real U-Proof history)
// ---------------------------------------------------------------------------
const STAGING_ENV = "Staging — uproof (WordPress + Elementor Pro + WooCommerce)";

function completeTicket(
  n: number,
  code: string,
  title: string,
  agentId: string,
  phase: Ticket["phase"],
  objective: string,
  extra: Partial<Ticket> = {},
): Ticket {
  return {
    id: `t_${code.toLowerCase()}`,
    code,
    projectId: PROJECT_UPROOF,
    title,
    agentId,
    phase,
    status: "COMPLETE",
    priority: "P2",
    objective,
    environment: STAGING_ENV,
    scope: [],
    doNotChange: ["Live production site", "DNS / nameservers", "Payment credentials"],
    executionOutput: "Completed. See build/QA report artifact record for this ticket.",
    safetyCheck: "Executed on staging only. No production, DNS, or payment changes.",
    warnings: [],
    approvalState: "APPROVED",
    order: n,
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    ...extra,
  };
}

const B = AGENT_IDS.A05;
const Q = AGENT_IDS.A06;

const tickets: Ticket[] = [
  completeTicket(3, "CT-UP-003", "Elementor Global Design System", B, "BUILD", "Establish the Elementor global design system: colours, typography, spacing and component styles.", {
    scope: ["Global colours", "Global typography", "Container defaults", "Button styles"],
  }),
  completeTicket(4, "CT-UP-003A", "Normalize Global Tokens", B, "BUILD", "Normalise global design tokens so every template inherits a single source of truth.", {
    scope: ["Token naming", "Remove inline overrides"],
  }),
  completeTicket(5, "CT-UP-005", "Header", B, "BUILD", "Build the site-wide header template.", { scope: ["Header template", "Navigation", "Mobile menu"] }),
  completeTicket(6, "CT-UP-006", "Footer", B, "BUILD", "Build the site-wide footer template.", { scope: ["Footer template", "Contact block", "Legal links"] }),
  completeTicket(7, "CT-UP-007", "Homepage Visual Preview", B, "BUILD", "Produce a visual preview of the homepage for human design approval.", {
    scope: ["Homepage preview"],
  }),
  completeTicket(8, "CT-UP-008", "Structural Corrections", B, "BUILD", "Apply structural corrections from homepage preview review.", {
    scope: ["Section structure", "Spacing corrections"],
  }),
  completeTicket(9, "CT-UP-009", "Complete Homepage", B, "BUILD", "Complete the homepage build.", { scope: ["Homepage — Preview ID 290"] }),
  completeTicket(10, "CT-UP-010", "Shop Preview", B, "BUILD", "Build a shop preview page.", {
    scope: ["Shop Preview — Preview ID 291"],
    warnings: ["Superseded architecture — replaced by the Product Archive template (292)."],
  }),
  completeTicket(11, "CT-UP-011", "Product Archive", B, "BUILD", "Build the WooCommerce product archive template.", {
    scope: ["Product Archive — Template ID 292"],
    warnings: ["Requires controlled live visual testing before activation (launch hold)."],
  }),
  completeTicket(12, "CT-UP-012", "Single Product Template", B, "BUILD", "Build the WooCommerce single product template.", {
    scope: ["Single Product — Template ID 293", "Variations", "Add-to-Cart", "Gallery"],
    warnings: ["Controlled live interaction testing required (variations / Add-to-Cart / gallery)."],
  }),
  completeTicket(13, "CT-UP-013", "Roof Waterproofing", B, "BUILD", "Build the Roof Waterproofing solution page.", { scope: ["Preview ID 294"] }),
  completeTicket(14, "CT-UP-014", "Metal Roof Waterproofing", B, "BUILD", "Build the Metal Roof Waterproofing solution page.", { scope: ["Preview ID 295"] }),
  completeTicket(15, "CT-UP-015", "Concrete Waterproofing", B, "BUILD", "Build the Concrete Waterproofing solution page.", { scope: ["Preview ID 296"] }),
  completeTicket(16, "CT-UP-016-BATCH", "Remaining Solution Pages", B, "BUILD", "Build the remaining solution pages as a batch.", {
    scope: ["Gutter Waterproofing (297)", "Balcony & Terrace Waterproofing (298)", "Wall & Parapet Waterproofing (299)"],
  }),
  completeTicket(17, "CT-UP-017-BATCH", "Supporting Pages", B, "BUILD", "Build the supporting pages as a batch.", {
    scope: ["How It Works (300)", "Help & Advice (301)", "About (302)", "Contact (303)"],
  }),
  completeTicket(18, "CT-UP-018-BATCH", "Ecommerce Utility + Legal", B, "BUILD", "Build ecommerce utility and legal pages as a batch.", {
    scope: ["Cart (304)", "Checkout (305)", "My Account (306)", "Terms (307)", "Privacy (308)"],
  }),
  completeTicket(19, "CT-UP-019", "Whole-Site QA", Q, "QA", "Run independent whole-site QA across all built pages and templates.", {
    scope: ["All pages 290–308", "Responsive", "Visual", "Content", "WooCommerce", "SEO", "Forms", "Technical"],
    executionOutput: "Whole-site QA completed. Findings routed to CT-UP-020.",
  }),
  completeTicket(20, "CT-UP-020", "Final Priority Fix", B, "QA", "Fix the priority defect identified in whole-site QA.", {
    scope: ["Responsive defect fix"],
    executionOutput: "Responsive defect fixed and verified.",
  }),
  completeTicket(21, "CT-UP-021", "Final Regression Audit", Q, "QA", "Final regression audit across the whole site after priority fixes.", {
    scope: ["All pages 290–308", "Regression"],
    executionOutput: "PASS. P0 0 · P1 0 · P2 0 · P3 0. Ready for Human Review: YES. Ready for Controlled Activation Testing: YES.",
    priority: "P1",
  }),
];

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
type PageSeed = [title: string, type: ProjectPage["type"], kind: "PREVIEW" | "TEMPLATE", ref: number, ticket: string, hold?: string, build?: ProjectPage["buildStatus"], notes?: string];

const pageSeeds: PageSeed[] = [
  ["Homepage", "Page", "PREVIEW", 290, "CT-UP-009"],
  ["Shop Preview", "Page", "PREVIEW", 291, "CT-UP-010", undefined, "SUPERSEDED", "Superseded by Product Archive (292)."],
  ["Product Archive", "Archive Template", "TEMPLATE", 292, "CT-UP-011", "Activation-test hold"],
  ["Single Product", "Single Template", "TEMPLATE", 293, "CT-UP-012", "Live-interaction hold"],
  ["Roof Waterproofing", "Solution", "PREVIEW", 294, "CT-UP-013"],
  ["Metal Roof Waterproofing", "Solution", "PREVIEW", 295, "CT-UP-014"],
  ["Concrete Waterproofing", "Solution", "PREVIEW", 296, "CT-UP-015"],
  ["Gutter Waterproofing", "Solution", "PREVIEW", 297, "CT-UP-016-BATCH"],
  ["Balcony & Terrace Waterproofing", "Solution", "PREVIEW", 298, "CT-UP-016-BATCH"],
  ["Wall & Parapet Waterproofing", "Solution", "PREVIEW", 299, "CT-UP-016-BATCH"],
  ["How It Works", "Page", "PREVIEW", 300, "CT-UP-017-BATCH"],
  ["Help & Advice", "Page", "PREVIEW", 301, "CT-UP-017-BATCH"],
  ["About", "Page", "PREVIEW", 302, "CT-UP-017-BATCH"],
  ["Contact", "Page", "PREVIEW", 303, "CT-UP-017-BATCH", "Data hold"],
  ["Cart", "Utility", "PREVIEW", 304, "CT-UP-018-BATCH"],
  ["Checkout", "Utility", "PREVIEW", 305, "CT-UP-018-BATCH"],
  ["My Account", "Utility", "PREVIEW", 306, "CT-UP-018-BATCH"],
  ["Terms", "Legal", "PREVIEW", 307, "CT-UP-018-BATCH", "Client-policy hold"],
  ["Privacy", "Legal", "PREVIEW", 308, "CT-UP-018-BATCH", "Client-policy hold"],
];

const pages: ProjectPage[] = pageSeeds.map(([title, type, kind, ref, ticket, hold, build, notes]) => ({
  id: `page_up_${ref}`,
  projectId: PROJECT_UPROOF,
  title,
  type,
  buildStatus: build ?? "COMPLETE",
  qaStatus: "PASS",
  wpRefKind: kind,
  wpRefId: ref,
  holdNote: hold,
  notes,
  ticketId: `t_${ticket.toLowerCase()}`,
  updatedAt: null,
}));

// ---------------------------------------------------------------------------
// Launch holds (NOT defects)
// ---------------------------------------------------------------------------
const launchHolds: LaunchHold[] = [
  {
    id: "hold_up_1",
    projectId: PROJECT_UPROOF,
    pageId: "page_up_292",
    title: "Product Archive (292) requires controlled live visual testing",
    owner: "Creative Touch",
    resolved: false,
    resolvedAt: null,
    createdAt: null,
  },
  {
    id: "hold_up_2",
    projectId: PROJECT_UPROOF,
    pageId: "page_up_293",
    title: "Single Product (293) requires live variation / Add-to-Cart / gallery testing",
    owner: "Creative Touch",
    resolved: false,
    resolvedAt: null,
    createdAt: null,
  },
  {
    id: "hold_up_3",
    projectId: PROJECT_UPROOF,
    pageId: "page_up_303",
    title: "Contact phone number and business hours require client confirmation",
    owner: "Client",
    resolved: false,
    resolvedAt: null,
    createdAt: null,
  },
  {
    id: "hold_up_4",
    projectId: PROJECT_UPROOF,
    pageId: "page_up_303",
    title: "Contact form SMTP / email delivery remains unverified",
    owner: "Creative Touch",
    resolved: false,
    resolvedAt: null,
    createdAt: null,
  },
  {
    id: "hold_up_5",
    projectId: PROJECT_UPROOF,
    pageId: "page_up_307",
    title: "Terms return policy requires client confirmation",
    owner: "Client",
    resolved: false,
    resolvedAt: null,
    createdAt: null,
  },
  {
    id: "hold_up_6",
    projectId: PROJECT_UPROOF,
    pageId: "page_up_307",
    title: "Terms/Privacy payment wording conflicts with current WooCommerce gateway state",
    detail:
      "Observed gateway state: Direct Bank Transfer enabled · Cheque enabled · Cash on Delivery enabled · Paystack disabled · Payflex configured but unavailable. Legal wording must be reconciled with the gateways that will actually be live.",
    owner: "Client / Creative Touch",
    resolved: false,
    resolvedAt: null,
    createdAt: null,
  },
  {
    id: "hold_up_7",
    projectId: PROJECT_UPROOF,
    title: "Rank Math frontend output currently inactive because of plugin registration state",
    owner: "Creative Touch",
    resolved: false,
    resolvedAt: null,
    createdAt: null,
  },
  {
    id: "hold_up_8",
    projectId: PROJECT_UPROOF,
    title: "Structured product technical data is incomplete",
    owner: "Client",
    resolved: false,
    resolvedAt: null,
    createdAt: null,
  },
  {
    id: "hold_up_9",
    projectId: PROJECT_UPROOF,
    title: "Some application-specific photography is still missing",
    owner: "Client",
    resolved: false,
    resolvedAt: null,
    createdAt: null,
  },
];

// ---------------------------------------------------------------------------
// QA items — final audit CT-UP-021: zero open defects at every severity.
// The single historical defect (fixed in CT-UP-020) is kept as a VERIFIED record.
// ---------------------------------------------------------------------------
const qaItems: QAItem[] = [
  {
    id: "qa_up_1",
    projectId: PROJECT_UPROOF,
    ticketId: "t_ct-up-020",
    title: "Responsive defect identified in whole-site QA",
    severity: "P1",
    category: "Responsive",
    description: "Priority responsive defect raised by CT-UP-019 Whole-Site QA; fixed in CT-UP-020 and verified by CT-UP-021 Final Regression Audit.",
    assignedAgentId: AGENT_IDS.A05,
    qaRunId: "qarun_up_019",
    status: "VERIFIED",
    createdAt: null,
    resolvedAt: null,
  },
];

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------
const approvals: Approval[] = [
  { id: "appr_up_strategy", projectId: PROJECT_UPROOF, gate: "STRATEGY", requestedBy: "Orchestrator", status: "APPROVED", decidedBy: "Production Lead", decidedById: null, decidedAt: null, createdAt: null },
  { id: "appr_up_design", projectId: PROJECT_UPROOF, gate: "DESIGN", requestedBy: "Orchestrator", status: "APPROVED", decidedBy: "Production Lead", decidedById: null, decidedAt: null, createdAt: null },
  { id: "appr_up_staging", projectId: PROJECT_UPROOF, gate: "STAGING_BUILD", requestedBy: "Orchestrator", status: "APPROVED", decidedBy: "Production Lead", decidedById: null, decidedAt: null, createdAt: null },
  {
    id: "appr_up_launch",
    projectId: PROJECT_UPROOF,
    gate: "LAUNCH",
    requestedBy: "Orchestrator",
    status: "PENDING",
    notes: "QA is zero at every severity, but launch requires human approval and resolution of open launch holds. It will not auto-approve.",
    decidedById: null,
    decidedAt: null,
    createdAt: null,
  },
];

// ---------------------------------------------------------------------------
// Artifacts — metadata records only (storageLocation null: no file is claimed to exist)
// ---------------------------------------------------------------------------
function artifact(seed: Pick<Artifact, "id" | "type" | "title" | "createdByAgentId"> & Partial<Artifact>): Artifact {
  return {
    projectId: PROJECT_UPROOF,
    version: 1,
    createdByProvider: null,
    status: "FINAL",
    storageLocation: null,
    schemaVersion: 1,
    supersedesArtifactId: null,
    createdAt: null,
    updatedAt: null,
    ...seed,
  };
}

const artifacts: Artifact[] = [
  artifact({ id: "art_up_brief", type: "project_brief", title: "Project Brief", createdByAgentId: AGENT_IDS.ORCH, summary: "Ecommerce rebuild brief for U-Proof." }),
  artifact({ id: "art_up_discovery", type: "research_report", title: "Research / Discovery Report", createdByAgentId: AGENT_IDS.A01 }),
  artifact({ id: "art_up_ux", type: "site_blueprint", title: "UX Plan", createdByAgentId: AGENT_IDS.A02 }),
  artifact({ id: "art_up_ds", type: "design_system", title: "Design System", createdByAgentId: AGENT_IDS.A03, ticketId: "t_ct-up-003" }),
  artifact({ id: "art_up_content", type: "content_pack", title: "Content Map", createdByAgentId: AGENT_IDS.A04 }),
  artifact({ id: "art_up_build", type: "build_report", title: "Build Reports (CT-UP-003 → CT-UP-018)", createdByAgentId: AGENT_IDS.A05 }),
  artifact({ id: "art_up_qa", type: "qa_report", title: "QA Audit (CT-UP-019)", createdByAgentId: AGENT_IDS.A06, ticketId: "t_ct-up-019" }),
  artifact({
    id: "art_up_regression",
    type: "qa_report",
    title: "Final Regression Audit (CT-UP-021)",
    createdByAgentId: AGENT_IDS.A06,
    ticketId: "t_ct-up-021",
    summary: "PASS — P0 0, P1 0, P2 0, P3 0. Ready for human review and controlled activation testing.",
  }),
  artifact({
    id: "art_up_lessons",
    type: "lesson_candidate",
    title: "U-Proof Lesson Candidates (CTOS-001 seed)",
    createdByAgentId: AGENT_IDS.A08,
    status: "DRAFT",
    summary: "Ten lesson candidates drawn from the U-Proof build and QA history. Pending human review in Knowledge.",
  }),
];

// ---------------------------------------------------------------------------
// QA runs — the two audits recorded in the ticket history
// ---------------------------------------------------------------------------
const qaRuns: QARun[] = [
  {
    id: "qarun_up_019",
    projectId: PROJECT_UPROOF,
    ticketId: "t_ct-up-019",
    runByAgentId: AGENT_IDS.A06,
    scope: ["All pages 290–308", "Responsive", "Visual", "Content", "WooCommerce", "SEO", "Forms", "Technical"],
    result: "ISSUES_FOUND",
    counts: { P0: 0, P1: 1, P2: 0, P3: 0 },
    summary: "Whole-site QA. One priority responsive defect raised and routed to CT-UP-020.",
    artifactId: "art_up_qa",
    startedAt: null,
    finishedAt: null,
  },
  {
    id: "qarun_up_021",
    projectId: PROJECT_UPROOF,
    ticketId: "t_ct-up-021",
    runByAgentId: AGENT_IDS.A06,
    scope: ["All pages 290–308", "Regression"],
    result: "PASS",
    counts: { P0: 0, P1: 0, P2: 0, P3: 0 },
    summary: "Final regression audit PASS. Ready for human review and controlled activation testing.",
    artifactId: "art_up_regression",
    startedAt: null,
    finishedAt: null,
  },
];

// ---------------------------------------------------------------------------
// Gate definitions (reference data)
// ---------------------------------------------------------------------------
export const gates: GateDefinition[] = [
  {
    id: "gate_strategy",
    key: "STRATEGY",
    label: "Strategy",
    order: 1,
    requiresHumanApproval: true,
    requiredArtifactTypes: ["research_report", "site_blueprint"],
    confirmOnOpenHolds: false,
    description: "Human confirms the research and site blueprint before design starts.",
  },
  {
    id: "gate_design",
    key: "DESIGN",
    label: "Design",
    order: 2,
    requiresHumanApproval: true,
    requiredArtifactTypes: ["design_system"],
    confirmOnOpenHolds: false,
    description: "Human design approval of the visual direction and homepage preview.",
  },
  {
    id: "gate_staging",
    key: "STAGING_BUILD",
    label: "Staging Build",
    order: 3,
    requiresHumanApproval: true,
    requiredArtifactTypes: ["build_report", "qa_report"],
    confirmOnOpenHolds: false,
    description: "Human accepts the staging build after QA and the regression audit.",
  },
  {
    id: "gate_launch",
    key: "LAUNCH",
    label: "Launch",
    order: 4,
    requiresHumanApproval: true,
    requiredArtifactTypes: ["qa_report"],
    confirmOnOpenHolds: true,
    description: "Human launch approval. Never auto-approves on zero QA counts; open holds require explicit acceptance.",
  },
];

// ---------------------------------------------------------------------------
// Integrations — nothing is connected. Intelligence providers are stub adapters.
// ---------------------------------------------------------------------------
function integration(seed: Pick<Integration, "id" | "name" | "plane" | "purpose" | "status"> & Partial<Integration>): Integration {
  return { createdAt: null, updatedAt: null, ...seed };
}

export const integrations: Integration[] = [
  integration({ id: "supabase", name: "Supabase", plane: "control", purpose: "Persistence, auth and realtime for the OS store.", status: "NOT_CONNECTED" }),
  integration({ id: "claude", name: "Claude", plane: "intelligence", purpose: "Intelligence provider (Anthropic). Replaceable per agent.", status: "STUB", providerId: "claude" }),
  integration({ id: "openai", name: "OpenAI", plane: "intelligence", purpose: "Intelligence provider. Replaceable per agent.", status: "STUB", providerId: "openai" }),
  integration({ id: "gemini", name: "Gemini", plane: "intelligence", purpose: "Intelligence provider (Google). Replaceable per agent.", status: "STUB", providerId: "gemini" }),
  integration({ id: "orchestrator", name: "AI Orchestrator", plane: "execution", purpose: "Coordinates specialist agents and enforces approval gates.", status: "FUTURE" }),
  integration({ id: "wordpress-exec", name: "WordPress execution", plane: "execution", purpose: "Executes build tickets against staging via SSH + WP-CLI.", status: "FUTURE" }),
  integration({ id: "wordpress-mcp", name: "WordPress MCP", plane: "execution", purpose: "Structured read/write access to WordPress sites.", status: "FUTURE" }),
  integration({ id: "google", name: "Google", plane: "execution", purpose: "Search Console, Analytics, Tag Manager, Business Profile.", status: "FUTURE" }),
  integration({ id: "meta", name: "Meta", plane: "execution", purpose: "Pixel, domain verification, business assets.", status: "FUTURE" }),
  integration({ id: "cloudflare", name: "Cloudflare", plane: "execution", purpose: "DNS, proxy and SSL for client zones.", status: "FUTURE" }),
  integration({ id: "hosting", name: "Hosting", plane: "execution", purpose: "Company-controlled host: staging, backups, SSH.", status: "FUTURE" }),
];

// ---------------------------------------------------------------------------
// Knowledge — DOCTRINE (rules already in force in this OS) and U-Proof lesson CANDIDATES.
// Candidates are NOT approved. Human review in the Knowledge screen decides.
// ---------------------------------------------------------------------------
function knowledge(seed: Pick<KnowledgeItem, "id" | "scope" | "category" | "title" | "content" | "status"> & Partial<KnowledgeItem>): KnowledgeItem {
  return {
    evidence: [],
    confidence: 0.5,
    projectId: null,
    jobId: null,
    proposedByAgentId: null,
    reviewedBy: null,
    reviewedById: null,
    reviewedAt: null,
    createdAt: null,
    updatedAt: null,
    ...seed,
  };
}

const doctrine: KnowledgeItem[] = [
  knowledge({
    id: "kn_doctrine_pipeline",
    scope: "DOCTRINE",
    category: "safety",
    title: "Every build passes through the safety pipeline",
    content: "BUILD → PREVIEW → HUMAN DESIGN APPROVAL → QA → FINAL REGRESSION AUDIT → CONTROLLED ACTIVATION TESTING → HUMAN LAUNCH APPROVAL → LIVE. No stage may be skipped by an agent.",
    status: "APPROVED",
    confidence: 1,
    reviewedBy: "Production Lead",
    evidence: ["state-machine SAFETY_PIPELINE"],
  }),
  knowledge({
    id: "kn_doctrine_permissions",
    scope: "DOCTRINE",
    category: "safety",
    title: "GREEN / AMBER / RED permission tiers",
    content: "GREEN actions run automatically. AMBER actions require explicit human approval before execution. RED actions (DNS, registrar, payment credentials, destructive infrastructure) are never executed by an agent without explicit, named authorization.",
    status: "APPROVED",
    confidence: 1,
    reviewedBy: "Production Lead",
    evidence: ["state-machine PERMISSION_MODEL"],
  }),
  knowledge({
    id: "kn_doctrine_launch",
    scope: "DOCTRINE",
    category: "safety",
    title: "Launch never auto-approves",
    content: "QA at zero is necessary, never sufficient, for launch. Launch requires human approval; approving with open launch holds is a deliberate, recorded human decision.",
    status: "APPROVED",
    confidence: 1,
    reviewedBy: "Production Lead",
    evidence: ["appr_up_launch"],
  }),
  knowledge({
    id: "kn_doctrine_learning",
    scope: "DOCTRINE",
    category: "process",
    title: "Agents propose; humans approve knowledge",
    content: "Agents may propose lesson candidates. No agent may promote its own output into AGENCY or DOCTRINE knowledge. Human approval is the only path from CANDIDATE to APPROVED.",
    status: "APPROVED",
    confidence: 1,
    reviewedBy: "Production Lead",
    evidence: ["CTOS-001 Part F"],
  }),
];

type LessonSeed = [id: string, category: KnowledgeItem["category"], title: string, content: string, evidence: string[]];

const uproofLessonSeeds: LessonSeed[] = [
  ["builder_no_self_certify", "qa", "Builder must not self-certify visual quality", "The agent that built a page may not be the one that certifies its visual quality. Visual sign-off comes from QA (06) or a human.", ["CT-UP-007", "CT-UP-008", "CT-UP-019"]],
  ["elementor_reread_after_save", "elementor", "Structured Elementor writes must be re-read after save", "After writing Elementor data, read it back and compare before reporting success. A write that returns without error is not proof the layout persisted.", ["CT-UP-003A", "CT-UP-016-BATCH"]],
  ["browser_render_over_http200", "qa", "Browser rendering beats HTTP-200 checks", "An HTTP 200 proves the page served, not that it rendered correctly. QA evidence must come from a real browser render.", ["CT-UP-019", "CT-UP-021"]],
  ["real_viewport_responsive_qa", "qa", "Real viewport emulation required for responsive QA", "Responsive QA must emulate real device viewports. Resizing a desktop window is not sufficient evidence.", ["CT-UP-019", "CT-UP-020", "qa_up_1"]],
  ["wp_slash_semantics", "wordpress", "wp_slash semantics differ between WordPress metadata APIs and raw DB writes", "WordPress metadata APIs expect slashed input while raw database writes do not. Mixing them corrupts serialized Elementor data.", ["CT-UP-003A"]],
  ["raw_db_writes_fallback_only", "wordpress", "Raw database writes are a narrowly-scoped fallback only", "Prefer WordPress/Elementor APIs. Raw database writes are permitted only for a narrowly defined case, with a backup taken first and a re-read afterwards.", ["CT-UP-003A", "CT-UP-016-BATCH"]],
  ["backup_before_mutation", "safety", "Back up before every material mutation stage", "Take a verified backup before any stage that materially mutates the site (design system changes, batch page builds, template assignment, activation).", ["CT-UP-003", "CT-UP-018-BATCH"]],
  ["shared_template_css_propagation", "elementor", "Shared template CSS propagation must be verified on consuming pages", "A change to a shared template or global style must be verified on the pages that consume it, not only on the template itself.", ["CT-UP-003A", "CT-UP-005", "CT-UP-006"]],
  ["visual_vs_implementation_qa", "qa", "Visual QA and implementation QA are separate responsibilities", "Implementation QA (does it work) and visual QA (does it look right) are different checks with different evidence, and must both be recorded.", ["CT-UP-019", "CT-UP-021"]],
  ["human_journey_qa_launch_gate", "qa", "Human/client journey QA is a launch gate", "A human walking the real customer journey (browse → product → cart → checkout → contact) is a launch gate, not an optional extra, regardless of automated QA results.", ["hold_up_1", "hold_up_2", "appr_up_launch"]],
];

const uproofLessonCandidates: KnowledgeItem[] = uproofLessonSeeds.map(([key, category, title, content, evidence]) =>
  knowledge({
    id: `kn_up_${key}`,
    scope: "AGENCY",
    category,
    title,
    content,
    evidence,
    confidence: 0.6,
    status: "CANDIDATE",
    projectId: null,
    proposedByAgentId: AGENT_IDS.A08,
  }),
);

const knowledgeItems: KnowledgeItem[] = [...doctrine, ...uproofLessonCandidates];

const agentLessons: AgentLesson[] = uproofLessonSeeds.map(([key]) => ({
  id: `lesson_up_${key}`,
  projectId: PROJECT_UPROOF,
  agentId: AGENT_IDS.A08,
  knowledgeItemId: `kn_up_${key}`,
  proposedScope: "AGENCY",
  sourceArtifactId: "art_up_lessons",
  sourceJobId: null,
  source: "CTOS-001 seed — lesson candidates supplied from the U-Proof build and QA history",
  status: "CANDIDATE",
  reviewedBy: null,
  reviewedById: null,
  reviewedAt: null,
  createdAt: null,
}));

// ---------------------------------------------------------------------------
// Activity — ordered by ticket sequence; `at` is null (historical times not recorded)
// ---------------------------------------------------------------------------
const activitySeeds: [ref: string, kind: ActivityEvent["kind"], message: string, actor: string][] = [
  ["CT-UP-003", "TICKET_COMPLETED", "Design System completed", "05 Builder"],
  ["CT-UP-003A", "TICKET_COMPLETED", "Global tokens normalised", "05 Builder"],
  ["CT-UP-005", "TICKET_COMPLETED", "Header completed", "05 Builder"],
  ["CT-UP-006", "TICKET_COMPLETED", "Footer completed", "05 Builder"],
  ["CT-UP-007", "TICKET_COMPLETED", "Homepage visual preview produced", "05 Builder"],
  ["CT-UP-008", "TICKET_COMPLETED", "Structural corrections applied", "05 Builder"],
  ["CT-UP-009", "TICKET_COMPLETED", "Homepage completed (Preview 290)", "05 Builder"],
  ["CT-UP-010", "TICKET_COMPLETED", "Shop Preview completed (291) — later superseded by Product Archive", "05 Builder"],
  ["CT-UP-011", "TICKET_COMPLETED", "Product Archive template completed (292)", "05 Builder"],
  ["CT-UP-012", "TICKET_COMPLETED", "Single Product template completed (293)", "05 Builder"],
  ["CT-UP-013", "TICKET_COMPLETED", "Roof Waterproofing completed (294)", "05 Builder"],
  ["CT-UP-014", "TICKET_COMPLETED", "Metal Roof Waterproofing completed (295)", "05 Builder"],
  ["CT-UP-015", "TICKET_COMPLETED", "Concrete Waterproofing completed (296)", "05 Builder"],
  ["CT-UP-016-BATCH", "TICKET_COMPLETED", "Remaining solution pages completed (297–299)", "05 Builder"],
  ["CT-UP-017-BATCH", "TICKET_COMPLETED", "Supporting pages completed (300–303)", "05 Builder"],
  ["CT-UP-018-BATCH", "TICKET_COMPLETED", "Ecommerce utility + legal pages completed (304–308)", "05 Builder"],
  ["CT-UP-019", "QA_RUN", "Whole-site QA completed", "06 QA Auditor"],
  ["CT-UP-020", "QA_FIX", "Responsive defect fixed", "05 Builder"],
  ["CT-UP-021", "QA_PASS", "Final regression audit PASS — P0 0 · P1 0 · P2 0 · P3 0", "06 QA Auditor"],
  ["LAUNCH", "APPROVAL", "Launch approval requested — pending human review and 9 open launch holds", "Orchestrator"],
];

const activity: ActivityEvent[] = activitySeeds.map(([ref, kind, message, actor], i) => ({
  id: `act_up_${i + 1}`,
  projectId: PROJECT_UPROOF,
  kind,
  ref,
  message,
  actor,
  actorId: null,
  at: null,
  order: i + 1,
}));

// ---------------------------------------------------------------------------
export const seedData: OSData = {
  clients,
  projects,
  phases,
  agents,
  pages,
  tickets,
  artifacts,
  qaItems,
  qaRuns,
  launchHolds,
  approvals,
  gates,
  activity,
  agentJobs: [],
  agentRuns: [],
  handoffs: [],
  knowledgeItems,
  agentLessons,
  integrations,
  projectIntegrations: [],
  jobApprovals: [],
  executionLogs: [],
};

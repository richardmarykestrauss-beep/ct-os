/**
 * Creative Touch Website OS — core domain types.
 *
 * All entities use stable string IDs and explicit foreign-key-style references
 * so the in-memory repository can later be swapped for Supabase tables
 * without changing UI components.
 *
 * Dates: ISO strings. `null` means "unknown / not recorded" — never invent history.
 */

export type ISODate = string;

// ---------------------------------------------------------------------------
// Identity (Supabase Auth + profiles). Not part of OSData — comes from the auth session.
// ---------------------------------------------------------------------------

export type UserRole = "ADMIN" | "PRODUCTION_LEAD" | "TEAM_MEMBER" | "VIEWER";

export interface AuthUser {
  /** Supabase auth user id (uuid) or a `local_` id in local mode. */
  id: string;
  email: string | null;
  displayName: string;
  role: UserRole;
  /**
   * Whether this account is usable. Absent/undefined means active (local mode, and any caller that
   * predates this field, always are). Supabase accounts start inactive unless an invite matched at
   * sign-up, or an ADMIN has since activated them — see docs/AUTH-AND-PERMISSIONS.md. An inactive
   * user must be blocked from the app (UI) and from the gateway (server) alike; never trust one alone.
   */
  active?: boolean;
}

/** Who did something. Stored alongside the human-readable name so history stays legible. */
export interface ActorRef {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Project state machine
// ---------------------------------------------------------------------------

export type ProjectState =
  | "NEW"
  | "DISCOVERY"
  | "STRATEGY"
  | "DESIGN"
  | "CONTENT"
  | "READY_TO_BUILD"
  | "BUILDING"
  | "QA"
  | "READY_TO_LAUNCH"
  | "LIVE"
  | "MAINTENANCE"
  | "ARCHIVED";

export type ProjectType =
  | "NEW_WEBSITE"
  | "WEBSITE_REBUILD"
  | "ECOMMERCE_BUILD"
  | "ECOMMERCE_REBUILD"
  | "MIGRATION"
  | "LANDING_PAGE"
  | "MAINTENANCE_ONBOARDING";

export type Platform = "WordPress" | "Elementor" | "Elementor Pro" | "WooCommerce" | "Other";

// ---------------------------------------------------------------------------
// Pipeline phases (production pipeline shown on dashboards)
// ---------------------------------------------------------------------------

export type PhaseKey = "DISCOVERY" | "UX" | "CREATIVE" | "CONTENT" | "BUILD" | "QA" | "LAUNCH";

export type PhaseStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE" | "PENDING_HOLDS" | "BLOCKED";

export interface ProjectPhase {
  id: string;
  projectId: string;
  key: PhaseKey;
  label: string;
  status: PhaseStatus;
  order: number;
  /** Optional free-text note e.g. "Pending launch holds" */
  note?: string;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Client {
  id: string;
  name: string;
  websiteUrl?: string;
  contactName?: string;
  contactEmail?: string;
  notes?: string;
  createdAt: ISODate | null;
}

export interface Project {
  id: string;
  clientId: string;
  name: string;
  type: ProjectType;
  platforms: Platform[];
  /** Human platform summary e.g. "WordPress + Elementor Pro + WooCommerce" */
  platformSummary: string;
  domain?: string;
  state: ProjectState;
  /** Human-readable operational status, e.g. "BUILD COMPLETE / HUMAN REVIEW" */
  statusLabel: string;
  /** 0–100 production progress (approximate, not mathematically precise). */
  progress: number;
  progressNote?: string;
  currentPhase: string;
  nextAction: string;
  primaryGoal?: string;
  hasExistingWebsite?: boolean;
  notes?: string;
  createdAt: ISODate | null;
  updatedAt: ISODate | null;
}

export type AgentCode = "ORCH" | "A01" | "A02" | "A03" | "A04" | "A05" | "A06" | "A07" | "A08";

export type AgentStatus = "IDLE" | "WORKING" | "WAITING_APPROVAL" | "BLOCKED";

// ---------------------------------------------------------------------------
// Intelligence providers (replaceable — agents never belong to a provider)
// ---------------------------------------------------------------------------

export type ProviderId = "claude" | "openai" | "gemini";

/** What a job needs from a provider; the router filters providers by these. */
export type ProviderCapability = "text" | "structured_output" | "long_context" | "vision" | "code" | "review";

/** Per-agent provider policy. The agent identity is stable even if every entry changes. */
export interface AgentProviderPolicy {
  preferred: ProviderId;
  fallbacks: ProviderId[];
  /** Optional independent reviewer provider (e.g. Gemini reviews Claude's output). Not executed in Phase 1. */
  reviewer?: ProviderId | null;
}

export type PermissionLevel = "GREEN" | "AMBER" | "RED";

export interface Agent {
  id: string;
  code: AgentCode;
  /** Display code e.g. "01", "ORCH" */
  shortCode: string;
  name: string;
  role: string;
  responsibilities: string[];
  status: AgentStatus;
  statusDetail?: string;
  currentProjectId?: string | null;
  currentTicketId?: string | null;
  lastRunAt: ISODate | null;
  outputsProduced: number;
  /** Which intelligence provider this agent prefers and falls back to. */
  providerPolicy: AgentProviderPolicy;
  /** Highest permission tier the agent may act at without a human (see PERMISSION_MODEL). */
  permissionLevel: PermissionLevel;
  /** Capabilities the agent's jobs require from a provider. */
  requiredCapabilities: ProviderCapability[];
  /** Artifact types this agent normally produces (drives handoffs). */
  producesArtifactTypes: ArtifactType[];
  /** Artifact types this agent normally consumes (drives handoffs). */
  consumesArtifactTypes: ArtifactType[];
  /** Whether the agent may mutate a site. Agent 08 (Intelligence Curator) never builds. */
  canExecuteSiteChanges: boolean;
  createdAt: ISODate | null;
  updatedAt: ISODate | null;
}

export type PageType = "Page" | "Archive Template" | "Single Template" | "Utility" | "Legal" | "Solution";

export type BuildStatus = "QUEUED" | "BUILDING" | "COMPLETE" | "SUPERSEDED";

export type QAStatus = "NOT_RUN" | "IN_QA" | "PASS" | "FAIL";

export interface ProjectPage {
  id: string;
  projectId: string;
  title: string;
  type: PageType;
  buildStatus: BuildStatus;
  qaStatus: QAStatus;
  /** WordPress preview post ID or Elementor template ID */
  wpRefKind: "PREVIEW" | "TEMPLATE";
  wpRefId: number | null;
  /** Hold flag: linked launch hold or note (not a defect) */
  holdNote?: string;
  notes?: string;
  ticketId?: string;
  updatedAt: ISODate | null;
}

export type TicketStatus = "QUEUED" | "READY" | "BUILDING" | "REVIEW" | "COMPLETE" | "BLOCKED";

export type TicketPriority = "P0" | "P1" | "P2" | "P3";

export type TicketApprovalState = "NOT_REQUIRED" | "PENDING" | "APPROVED" | "NEEDS_REVISION";

export interface Ticket {
  id: string;
  /** Display code e.g. CT-UP-021 */
  code: string;
  projectId: string;
  title: string;
  agentId: string;
  phase: PhaseKey;
  status: TicketStatus;
  priority: TicketPriority;
  objective: string;
  environment: string;
  scope: string[];
  doNotChange: string[];
  executionOutput?: string;
  safetyCheck?: string;
  warnings: string[];
  approvalState: TicketApprovalState;
  order: number;
  createdAt: ISODate | null;
  updatedAt: ISODate | null;
  completedAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// Artifacts — the primary communication medium between agents
// ---------------------------------------------------------------------------

export type ArtifactType =
  | "project_brief"
  | "research_report"
  | "site_blueprint"
  | "design_system"
  | "content_pack"
  | "build_plan"
  | "build_report"
  | "qa_report"
  | "client_feedback"
  | "deployment_report"
  | "lesson_candidate"
  | "other";

export type ArtifactStatus = "DRAFT" | "FINAL" | "SUPERSEDED" | "REJECTED";

export interface Artifact {
  id: string;
  projectId: string;
  type: ArtifactType;
  title: string;
  /** Monotonic per lineage. A new version supersedes the previous artifact. */
  version: number;
  createdByAgentId: string | null;
  /** Provider that produced the content, or null when human-authored / seeded. */
  createdByProvider: ProviderId | null;
  ticketId?: string;
  jobId?: string;
  status: ArtifactStatus;
  /** Storage pointer (Supabase Storage path, URL, file path). null = metadata record only; no file is claimed to exist. */
  storageLocation: string | null;
  /** Version of the structured payload schema for this artifact type. */
  schemaVersion: number;
  supersedesArtifactId: string | null;
  summary?: string;
  /** Structured payload (validated against `type`/`schemaVersion` by consumers). Optional in Phase 1. */
  content?: unknown;
  createdAt: ISODate | null;
  updatedAt: ISODate | null;
}

export type QASeverity = "P0" | "P1" | "P2" | "P3";

export type QACategory =
  | "Responsive"
  | "Visual"
  | "Content"
  | "WooCommerce"
  | "SEO"
  | "Forms"
  | "Performance"
  | "Technical"
  | "Migration";

export type QAItemStatus = "OPEN" | "IN_PROGRESS" | "FIXED" | "VERIFIED" | "WONT_FIX";

export interface QAItem {
  id: string;
  projectId: string;
  pageId?: string;
  ticketId?: string;
  title: string;
  severity: QASeverity;
  category: QACategory;
  description: string;
  assignedAgentId?: string;
  qaRunId?: string;
  status: QAItemStatus;
  createdAt: ISODate | null;
  resolvedAt: ISODate | null;
}

export type QARunResult = "PASS" | "ISSUES_FOUND" | "FAIL" | "INCOMPLETE";

/** One QA execution (an audit). Items link to the run that raised them. */
export interface QARun {
  id: string;
  projectId: string;
  ticketId?: string;
  jobId?: string;
  runByAgentId: string;
  scope: string[];
  result: QARunResult;
  counts: { P0: number; P1: number; P2: number; P3: number };
  summary?: string;
  artifactId?: string;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
}

export type HoldOwner = "Creative Touch" | "Client" | "Client / Creative Touch";

export interface LaunchHold {
  id: string;
  projectId: string;
  pageId?: string;
  title: string;
  detail?: string;
  owner: HoldOwner;
  resolved: boolean;
  resolvedAt: ISODate | null;
  createdAt: ISODate | null;
}

export type ApprovalGate = "STRATEGY" | "DESIGN" | "STAGING_BUILD" | "LAUNCH";

export type ApprovalStatus = "PENDING" | "APPROVED" | "CHANGES_REQUESTED";

/** Reference definition of a human approval gate. Approvals are instances of a gate on a project. */
export interface GateDefinition {
  id: string;
  key: ApprovalGate;
  label: string;
  order: number;
  /** Always true in CT-OS — gates exist to put a human in the loop. */
  requiresHumanApproval: boolean;
  /** Artifact types that should exist (FINAL) before the gate is decided. */
  requiredArtifactTypes: ArtifactType[];
  /** If true, approving with open launch holds requires an explicit confirmation. */
  confirmOnOpenHolds: boolean;
  description: string;
}

export interface Approval {
  id: string;
  projectId: string;
  gate: ApprovalGate;
  requestedBy: string;
  status: ApprovalStatus;
  notes?: string;
  decidedBy?: string;
  /** Auth user id of the decider (CTOS-002). Null for historical/seeded rows. */
  decidedById: string | null;
  decidedAt: ISODate | null;
  createdAt: ISODate | null;
}

export type ActivityKind =
  | "PROJECT_CREATED"
  | "STATE_CHANGED"
  | "TICKET_CREATED"
  | "TICKET_STATUS"
  | "TICKET_COMPLETED"
  | "QA_RUN"
  | "QA_PASS"
  | "QA_FIX"
  | "APPROVAL"
  | "HOLD"
  | "AGENT"
  | "JOB"
  | "ARTIFACT"
  | "HANDOFF"
  | "KNOWLEDGE"
  | "NOTE";

export interface ActivityEvent {
  id: string;
  projectId: string | null;
  kind: ActivityKind;
  /** Short reference (ticket code, gate name) shown as a chip */
  ref?: string;
  message: string;
  actor: string;
  /** Auth user id when a human acted; null for agents/system/historical rows. */
  actorId: string | null;
  /** null when historical timing is unknown — display by order, not date */
  at: ISODate | null;
  order: number;
}

// ---------------------------------------------------------------------------
// Agent jobs, runs and handoffs
// ---------------------------------------------------------------------------

export type AgentJobStatus = "QUEUED" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "FAILED" | "CANCELLED";

export type AgentTaskType =
  | "research"
  | "ux_architecture"
  | "creative_direction"
  | "seo_content"
  | "build"
  | "qa_audit"
  | "deployment"
  | "curate_lessons"
  | "orchestrate";

/** The standard contract for asking an agent to do one unit of work. */
export interface AgentJob {
  id: string;
  projectId: string;
  agentId: string;
  ticketId?: string;
  taskType: AgentTaskType;
  instructions: string;
  inputArtifactIds: string[];
  availableToolIds: string[];
  /** Name/id of the JSON schema the output must satisfy (e.g. "site_blueprint@1"). */
  requiredOutputSchema: string;
  requiredCapabilities: ProviderCapability[];
  preferredProvider: ProviderId;
  fallbackProviders: ProviderId[];
  permissionLevel: PermissionLevel;
  status: AgentJobStatus;
  /** Set once a provider produced an accepted output artifact. */
  outputArtifactId: string | null;
  handoffId: string | null;
  /** Who asked for the job to run (auth user id). */
  requestedById: string | null;
  error?: string;
  createdAt: ISODate | null;
  updatedAt: ISODate | null;
  startedAt: ISODate | null;
  completedAt: ISODate | null;
}

export type AgentRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "FAILED_VALIDATION" | "SKIPPED";

export type ExecutionErrorCategory =
  | "provider_unavailable"
  | "provider_error"
  | "validation"
  | "permission_denied"
  | "auth"
  | "not_found"
  | "config"
  | "cancelled"
  | "invalid_state"
  | "internal";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  schema: string;
  issues: ValidationIssue[];
}

/** One attempt to execute a job on one provider. A job may have several runs (fallbacks). */
export interface AgentRun {
  id: string;
  jobId: string;
  projectId: string;
  agentId: string;
  providerId: ProviderId;
  /** Model identifier reported by the provider adapter; null for stubs. */
  model: string | null;
  attempt: number;
  status: AgentRunStatus;
  outputSummary?: string;
  error?: string;
  errorCategory: ExecutionErrorCategory | null;
  /** Structured-output validation result for this attempt (null when the provider never answered). */
  validation: ValidationResult | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
}

export type HandoffStatus = "PENDING" | "ACCEPTED" | "IN_PROGRESS" | "COMPLETED" | "REJECTED" | "CANCELLED";

/** A controlled artifact handoff between two agents. Never a free-form conversation. */
export interface Handoff {
  id: string;
  projectId: string;
  sourceAgentId: string;
  destinationAgentId: string;
  inputArtifactIds: string[];
  outputArtifactId: string | null;
  jobId: string | null;
  runId: string | null;
  status: HandoffStatus;
  note?: string;
  createdAt: ISODate | null;
  updatedAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// Knowledge / intelligence
// ---------------------------------------------------------------------------

export type KnowledgeScope = "DOCTRINE" | "AGENCY" | "PROJECT" | "TASK";

export type KnowledgeStatus = "CANDIDATE" | "APPROVED" | "REJECTED" | "DEPRECATED";

export type KnowledgeCategory =
  | "safety"
  | "qa"
  | "build"
  | "wordpress"
  | "elementor"
  | "design"
  | "content"
  | "conversion"
  | "client"
  | "process"
  | "performance"
  | "other";

export interface KnowledgeItem {
  id: string;
  scope: KnowledgeScope;
  category: KnowledgeCategory;
  title: string;
  content: string;
  /** Ticket codes, artifact ids, QA item ids, URLs — whatever supports the claim. */
  evidence: string[];
  /** 0–1. Candidates proposed by agents start low; human approval does not change it automatically. */
  confidence: number;
  status: KnowledgeStatus;
  /** Required for PROJECT and TASK scope; null for DOCTRINE and AGENCY. */
  projectId: string | null;
  /** TASK scope only — the job whose lifetime bounds this item. */
  jobId: string | null;
  /** Agent that proposed it, or null when human-authored. */
  proposedByAgentId: string | null;
  /** Human who approved/rejected/deprecated it. Never an agent. */
  reviewedBy: string | null;
  reviewedById: string | null;
  reviewedAt: ISODate | null;
  createdAt: ISODate | null;
  updatedAt: ISODate | null;
}

export type AgentLessonStatus = "CANDIDATE" | "APPROVED" | "REJECTED";

/**
 * The learning ledger: who proposed which lesson from what evidence, and what happened to it.
 * The lesson content itself lives in the linked KnowledgeItem (status CANDIDATE until a human decides).
 */
export interface AgentLesson {
  id: string;
  projectId: string | null;
  agentId: string;
  knowledgeItemId: string;
  /** Scope the proposer asks for. Humans may approve into a narrower scope. */
  proposedScope: Exclude<KnowledgeScope, "DOCTRINE" | "TASK">;
  sourceArtifactId: string | null;
  sourceJobId: string | null;
  /** Free text on where the proposal came from (e.g. "CTOS-001 seed"). */
  source: string;
  status: AgentLessonStatus;
  reviewedBy: string | null;
  reviewedById: string | null;
  reviewedAt: ISODate | null;
  createdAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// Integrations (execution plane)
// ---------------------------------------------------------------------------

export type IntegrationStatus = "NOT_CONNECTED" | "STUB" | "CONFIGURED" | "FUTURE";

export interface Integration {
  id: string;
  name: string;
  plane: "control" | "execution" | "intelligence";
  purpose: string;
  status: IntegrationStatus;
  /** For intelligence-plane rows, the provider id the ModelRouter knows it by. */
  providerId?: ProviderId;
  createdAt: ISODate | null;
  updatedAt: ISODate | null;
}

/** Non-secret binding of an integration to a project (e.g. staging URL). Secrets never live here. */
export interface ProjectIntegration {
  id: string;
  projectId: string;
  integrationId: string;
  /** Non-secret configuration (URLs, site ids). */
  config: Record<string, string>;
  /** Pointer to where the credential lives (vault key, env var name) — never the credential itself. */
  credentialsRef: string | null;
  status: "ACTIVE" | "INACTIVE";
  createdAt: ISODate | null;
  updatedAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// Job approvals (AMBER) and authorizations (RED) — checked server-side by the gateway
// ---------------------------------------------------------------------------

export type JobApprovalKind = "APPROVAL" | "AUTHORIZATION";

export type JobApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CONSUMED" | "EXPIRED";

export interface JobApproval {
  id: string;
  jobId: string;
  projectId: string;
  agentId: string;
  /** APPROVAL = AMBER (a lead approves someone's request). AUTHORIZATION = RED (the executor authorises themselves, tied to the action). */
  kind: JobApprovalKind;
  permissionLevel: PermissionLevel;
  /** Hash of (agent, task type, instructions, output schema) — the authorization is void if the action changes. */
  actionFingerprint: string;
  /** Plain-language description of what is being approved. */
  requestedAction: string;
  requestedById: string;
  requestedByName: string;
  approvedById: string | null;
  approvedByName: string | null;
  /** Role of the approver at decision time; the gateway re-verifies against profiles when it can. */
  approvedByRole: UserRole | null;
  status: JobApprovalStatus;
  note?: string;
  createdAt: ISODate | null;
  decidedAt: ISODate | null;
  consumedAt: ISODate | null;
  expiresAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// Execution logs — written by the gateway. Never contain secrets or tokens.
// ---------------------------------------------------------------------------

export type ExecutionLogStatus = "COMPLETED" | "FAILED" | "FAILED_VALIDATION" | "REJECTED" | "SKIPPED";

export interface ExecutionLog {
  id: string;
  jobId: string;
  runId: string | null;
  projectId: string;
  agentId: string;
  providerId: ProviderId | null;
  model: string | null;
  status: ExecutionLogStatus;
  /** Which provider attempt this was (0 = first). */
  fallbackIndex: number;
  permissionCheck: { level: PermissionLevel; outcome: "allowed" | "denied"; reason: string; approvalId: string | null };
  validation: ValidationResult | null;
  artifactId: string | null;
  errorCategory: ExecutionErrorCategory | null;
  errorMessage: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  latencyMs: number | null;
  requestedById: string | null;
  /** Provider output kept for diagnosis when validation failed. Never client-sensitive content beyond what the job already held. */
  rawOutput: unknown;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// Aggregate store shape (what a repository returns)
// ---------------------------------------------------------------------------

export interface OSData {
  clients: Client[];
  projects: Project[];
  phases: ProjectPhase[];
  agents: Agent[];
  pages: ProjectPage[];
  tickets: Ticket[];
  artifacts: Artifact[];
  qaItems: QAItem[];
  qaRuns: QARun[];
  launchHolds: LaunchHold[];
  approvals: Approval[];
  gates: GateDefinition[];
  activity: ActivityEvent[];
  agentJobs: AgentJob[];
  agentRuns: AgentRun[];
  handoffs: Handoff[];
  knowledgeItems: KnowledgeItem[];
  agentLessons: AgentLesson[];
  integrations: Integration[];
  projectIntegrations: ProjectIntegration[];
  jobApprovals: JobApproval[];
  executionLogs: ExecutionLog[];
}

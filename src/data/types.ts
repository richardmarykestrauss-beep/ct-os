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
  | "DESIGN_AND_CONTENT"
  | "READY_TO_BUILD"
  | "BUILDING"
  | "QA"
  | "CLIENT_REVIEW"
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

/**
 * What a job needs from a provider; the router filters providers by these (CTOS-003 Part E).
 * "text" / "review" are CT-OS's original two; the rest were added so agent preferences can be
 * expressed precisely (e.g. Agent 03 Creative Director → creative_generation + vision).
 */
export type ProviderCapability = "text" | "structured_output" | "long_context" | "vision" | "code" | "review" | "reasoning" | "fast_generation" | "creative_generation";

/**
 * How a job wants the router to weigh candidates when more than one is available (CTOS-003 Part F).
 * BALANCED is the default when a job does not specify one — see `agent-jobs.ts#createJob`.
 */
export type ExecutionPriority = "QUALITY" | "BALANCED" | "COST" | "SPEED";

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
  /** One-line "why this agent exists" — optional; only a few agents have one written yet (CTOS-003 Part I). */
  mission?: string;
  /** Things this agent explicitly must not do, beyond the permission model (CTOS-003 Part I). */
  exclusions?: string[];
  /** Default priority for jobs this agent creates when the job doesn't specify one (CTOS-003 Part F/I). */
  defaultPriority?: ExecutionPriority;
  /** APPROVED-only instruction packs (see Skill, kind "instruction_pack") this agent's jobs draw on (CTOS-003 Part I). */
  instructionPackIds?: string[];
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
  | "build_pack"
  | "job_pack"
  | "build_plan"
  | "build_report"
  | "qa_report"
  | "client_feedback"
  | "deployment_report"
  | "lesson_candidate"
  | "agent_benchmark_report"
  | "blind_benchmark_report"
  | "cross_site_agent_evaluation"
  | "design_direction"
  | "page_composition"
  | "visual_review"
  | "elementor_build_manifest"
  // CTOS-006 additions
  | "website_change_plan"
  | "wp_write_result"
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

export type AgentJobStatus = "QUEUED" | "RUNNING" | "WAITING_APPROVAL" | "NEEDS_A_HAND" | "COMPLETED" | "FAILED" | "CANCELLED";

export type AgentTaskType =
  | "research"
  | "ux_architecture"
  | "creative_direction"
  | "design_direction"
  | "composition"
  | "visual_review"
  | "seo_content"
  | "build"
  | "qa_audit"
  | "deployment"
  | "curate_lessons"
  | "orchestrate"
  | "intake";

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
  /** How the router should weigh candidates. Optional; treat as "BALANCED" when absent (CTOS-003 Part F). */
  executionPriority?: ExecutionPriority;
  permissionLevel: PermissionLevel;
  status: AgentJobStatus;
  /** Set once a provider produced an accepted output artifact. */
  outputArtifactId: string | null;
  handoffId: string | null;
  /** Who asked for the job to run (auth user id). */
  requestedById: string | null;
  /**
   * Execution mode used for this job (CTOS-005A Part 6).
   * A = direct API, B = assisted/external subscription, C = manual human completion.
   * Optional for backward compatibility with pre-005A jobs (treat absent as "A").
   */
  executionMode?: ExecutionMode;
  /** Set when a Mode B export exists for this job (CTOS-005A Part 9). */
  modeBJobId?: string | null;
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
  /** inputTokens + outputTokens when at least one is known (CTOS-003 Part G). Optional for backward compatibility. */
  totalTokens?: number | null;
  /** From a versioned pricing config (src/ai/pricing.ts); null whenever the model/provider isn't in it. Never a guess. */
  estimatedCostUsd?: number | null;
  /** Human-readable reason this provider was ranked/selected — see src/ai/ranking.ts (CTOS-003 Part F). */
  selectionReason?: string | null;
  /** APPROVED skill ids (as "id@version") active in context for this attempt (CTOS-003 Part L). */
  skillIds?: string[];
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
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens?: number | null; estimatedCostUsd?: number | null } | null;
  latencyMs: number | null;
  requestedById: string | null;
  /** Provider output kept for diagnosis when validation failed. Never client-sensitive content beyond what the job already held. */
  rawOutput: unknown;
  /** Why this provider was tried at this position — see src/ai/ranking.ts (CTOS-003 Part F). */
  selectionReason?: string | null;
  /** APPROVED skill ids (as "id@version") active in context for this attempt (CTOS-003 Part L). */
  skillIds?: string[];
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// Skills and instruction packs (CTOS-003 Parts I, J, K, L)
//
// One versioned, approvable resource type covers two ticket concepts deliberately: an
// "instruction pack" (Part I — reusable agent behaviour, e.g. Agent 02's UX review checklist)
// and a "skill" (Parts J/K — CT Visual Design Skill, CT Elementor Builder Skill). Both are
// "an approved body of text an agent's context may include"; giving them one lifecycle
// (DRAFT → CANDIDATE → APPROVED → DEPRECATED) is the non-over-engineered reading of Part L,
// which lists exactly one set of versioning/approval fields for "skills" in general.
// ---------------------------------------------------------------------------

export type SkillKind = "instruction_pack" | "design_review" | "build_practice" | "other";

export type SkillStatus = "DRAFT" | "CANDIDATE" | "APPROVED" | "DEPRECATED" | "REJECTED";

export interface Skill {
  id: string;
  name: string;
  /** Monotonic per lineage (see supersedesId). Editing an APPROVED skill creates version + 1, not an in-place edit. */
  version: number;
  kind: SkillKind;
  status: SkillStatus;
  /** Free-text scope label, e.g. "agent-behaviour", "design-review", "build-practice". */
  scope: string;
  /** Agents this skill primarily belongs to. */
  ownerAgentIds: string[];
  /** Agents that may reference this skill without owning it (e.g. Agent 06 QA referencing Agent 03/05's skills). */
  reviewerAgentIds: string[];
  content: string;
  /** Ticket codes, project names, artifact ids — whatever grounds the skill in real validated experience. */
  evidence: string[];
  /** Previous version's id in this lineage, or null for the first version. */
  supersedesId: string | null;
  /** Human who approved it. Never an agent — see services/skills.ts#approveSkill. */
  approvedBy: string | null;
  approvedById: string | null;
  approvedAt: ISODate | null;
  createdAt: ISODate | null;
  updatedAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// External assistant access (CTOS-004) - controlled MCP tool bridge
//
// An ExternalClient is a registered identity for an outside assistant (ChatGPT, another Claude
// session, a future automation) that talks to CT-OS only through the MCP tool layer, never the
// database directly. It carries its own permission ceiling - separate from, and always at or
// below, the CT-OS human/agent permission model - and every tool call it makes is written to
// externalAccessLog. See src/mcp/ and docs/MCP-BRIDGE.md.
// ---------------------------------------------------------------------------

export type ExternalClientType = "chatgpt" | "claude" | "automation" | "other";

export type ExternalClientStatus = "ACTIVE" | "DISABLED" | "REVOKED";

/**
 * The maximum a client may do WITHOUT a human in the loop:
 *  - READ_ONLY: read tools only, no writes of any kind.
 *  - GREEN_WRITE: read tools + the safe structured write tools (ticket.create, ticket.comment,
 *    client_feedback.add, knowledge.propose - always CANDIDATE, agent_job.request - GREEN jobs
 *    only enter the queue automatically).
 * AMBER and RED are never a ceiling value: every external client, at any ceiling, may only ever
 * CREATE an AMBER approval request or a RED authorization request - it can never decide/self-approve
 * one, and a RED job it requests is left QUEUED with no execution until a human authorizes it in
 * CT-OS itself. This is enforced in src/mcp/registry.ts and src/services/external-clients.ts, not
 * just documented here.
 */
export type ExternalPermissionCeiling = "READ_ONLY" | "GREEN_WRITE";

export interface ExternalClient {
  id: string;
  name: string;
  type: ExternalClientType;
  status: ExternalClientStatus;
  permissionCeiling: ExternalPermissionCeiling;
  /** null = every tool the ceiling allows; otherwise an explicit allow-list of MCP tool names. */
  allowedTools: string[] | null;
  /** SHA-256 of the local bearer token. The raw token is shown once at creation and never stored. */
  tokenHash: string | null;
  /** First 8 chars of the raw token, kept only for identification in the UI/logs (never enough to authenticate). */
  tokenPrefix: string | null;
  /** Human (ADMIN/PRODUCTION_LEAD) who created this identity. Never an agent. */
  createdById: string | null;
  createdAt: ISODate | null;
  updatedAt: ISODate | null;
  lastUsedAt: ISODate | null;
  revokedAt: ISODate | null;
}

export type ExternalAccessResult = "allowed" | "denied" | "error";

/** One MCP tool call, recorded regardless of outcome - the audit trail Part D/L require. */
export interface ExternalAccessLogEntry {
  id: string;
  at: ISODate | null;
  externalClientId: string;
  externalClientName: string;
  tool: string;
  projectId: string | null;
  /** Authenticated CT-OS user/session this call is acting alongside, when one exists. Never implied. */
  ctosUserId: string | null;
  requestedAction: string;
  /** "READ" for a read tool; the job/approval permission tier for a write tool; null when the call never reached a tier decision. */
  permissionTier: PermissionLevel | "READ" | null;
  result: ExternalAccessResult;
  reason?: string;
  createdIds?: string[];
}
// ---------------------------------------------------------------------------
// CTOS-005A: Workflow v1 + Resilient Execution + Benchmark Hardening
// All additions are backward-compatible. Old records simply lack the new optional fields.
// ---------------------------------------------------------------------------

/** Workflow stages 0–7 per Workflow V1 (Part 3). Informational — state machine is the authority. */
export type WorkflowStage = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Execution mode for a job (Part 6).
 * A = direct API execution, B = assisted/external subscription, C = manual human completion.
 */
export type ExecutionMode = "A" | "B" | "C";

/** Transport used when execution mode is B or C (Part 7). */
export type JobPackTransport =
  | "API"
  | "CLAUDE_SUBSCRIPTION"
  | "CHATGPT_SUBSCRIPTION"
  | "GEMINI"
  | "HERMES"
  | "HUMAN"
  | "LOCAL_MODEL";

/**
 * Agent 03 Creative Director operating passes (Part 20).
 * DIRECTION: brand/direction analysis pass.
 * COMPOSITION: page composition design pass.
 * VISUAL_REVIEW: screenshot-based visual validation pass (requires real screenshots).
 */
export type AgentPass = "DIRECTION" | "COMPOSITION" | "VISUAL_REVIEW";

/**
 * Typed QA severity taxonomy (Part 18). Named aliases for the existing P0–P3 codes.
 * The existing QASeverity ("P0"–"P3") is kept for backward compatibility.
 */
export type QASeverityLevel = "CRITICAL" | "MAJOR" | "MINOR" | "COSMETIC";
/** Maps P-codes to the named severity levels for UI and test assertions. */
export const QA_SEVERITY_LEVEL: Record<QASeverity, QASeverityLevel> = {
  P0: "CRITICAL",
  P1: "MAJOR",
  P2: "MINOR",
  P3: "COSMETIC",
} as const;

/** Binary visual verification state for the central assessVisualVerification validator (Part 21). */
export type VisualVerificationState = "VISUAL_NOT_VERIFIED" | "VISUAL_VERIFIED";

/** QA operating modes supported by Agent 06 (Part 17). */
export type QAMode =
  | "TECHNICAL"
  | "VISUAL"
  | "RESPONSIVE"
  | "JOURNEY"
  | "CONTENT"
  | "SEO"
  | "LAUNCH_READINESS";

/**
 * Visual verification status for any artifact making visual claims (Part 19).
 * VISUAL_NOT_VERIFIED is the default when screenshots are absent.
 */
export type VisualVerificationStatus =
  | "VISUAL_NOT_VERIFIED"
  | "VERIFIED"
  | "SCREENSHOT_REQUIRED"
  | "NOT_APPLICABLE";

/** Screenshot capture metadata — required for any VISUAL_REVIEW job (Part 20). */
export interface ScreenshotEvidence {
  id: string;
  projectId: string;
  jobId: string | null;
  url: string;
  /** Viewport profile at capture time. */
  viewport: "desktop" | "mobile" | "tablet";
  widthPx: number;
  heightPx: number;
  capturedAt: ISODate | null;
  captureStatus: "captured" | "failed" | "pending";
  /** Browser console errors recorded during capture. */
  consoleErrors: string[];
  /** Page load errors (network, render). */
  loadErrors: string[];
}

/** Edit-protection metadata per page/template (Part 22). Stored alongside build artifacts. */
export interface HumanEditMetadata {
  /** Job that last wrote this page. */
  lastBuiltByJobId: string | null;
  /** Artifact version of the build pack used. */
  artifactVersion: number | null;
  /** SHA-256 of the canonical content at last-build time. */
  contentHash: string | null;
  /** True when content has changed since the last CT-OS build (detected externally). */
  humanEditDetected: boolean;
  lastCheckedAt: ISODate | null;
}

/**
 * Documented context budget for a job (Part 8).
 * Replaces magic truncation constants; every reduction is auditable.
 */
export interface ContextBudgetPlan {
  /** Provider maximum context window in tokens (approximate). */
  providerLimitTokens: number;
  /** Tokens reserved for the model's output. */
  reservedOutputTokens: number;
  systemBudgetTokens: number;
  skillBudgetTokens: number;
  projectBriefBudgetTokens: number;
  inputArtifactBudgetTokens: number;
  evidenceBudgetTokens: number;
  totalAllocatedTokens: number;
  remainingTokens: number;
}

/** Records one artifact content reduction so provenance is never lost (Part 8). */
export interface ContextReductionRecord {
  artifactId: string;
  originalChars: number;
  reducedChars: number;
  method: "field_selection" | "task_excerpt" | "summary_artifact" | "truncated";
  summarized: boolean;
  /** Source artifact ID is always preserved even when content is reduced. */
  sourceArtifactIdPreserved: true;
}

/**
 * Provider circuit state — supplements HealthTracker with a typed vocabulary (Part 11).
 * Mapped from HTTP status codes and error categories by the circuit breaker service.
 */
export type ProviderCircuitState =
  | "healthy"
  | "degraded"
  | "quota_exceeded"
  | "rate_limited"
  | "unavailable"
  | "not_configured";

/** Token and retry telemetry for a completed job — enables future cost visibility (Part 26). */
export interface RetryTelemetry {
  successInputTokens: number | null;
  successOutputTokens: number | null;
  /** Tokens consumed by attempts that failed (provider reports them). */
  failedAttemptInputTokens: number | null;
  failedAttemptOutputTokens: number | null;
  retryCount: number;
  /** Provider error class that triggered the retry (e.g. "validation", "provider_unavailable"). */
  providerErrorClass: string | null;
  fallbackAttempts: number;
  finalExecutionMode: ExecutionMode;
}

// ---------------------------------------------------------------------------
// Build pack (Part 5) — the single authoritative build contract for Agent 05
// ---------------------------------------------------------------------------

export type BuildPackStatus = "ASSEMBLING" | "READY" | "CONFLICT" | "SUPERSEDED";

export interface BuildPackConflict {
  kind:
    | "section_missing_from_blueprint"
    | "content_field_unresolvable"
    | "cross_project_artifact"
    | "design_contradicts_constraint"
    | "section_dependency_unavailable"
    | "missing_required_content";
  detail: string;
  /** Artifact IDs involved in the conflict. */
  artifactIds: string[];
}

export interface BuildPackPage {
  path: string;
  title: string;
  templateType: string;
  sectionRequirements: string[];
  /** Maps section keys to approved content field values. */
  contentMappings: Record<string, string>;
  responsiveRequirements: string[];
  seoMeta: { title: string; metaDescription: string; h1: string };
  assetRefs: string[];
}

/**
 * The single authoritative build contract produced by the build-pack assembler (Part 5).
 * Agent 05 (Builder) receives ONLY the approved build pack — never raw upstream artifacts.
 * Assembly fails closed on conflicts; Agent 05 never decides which conflicting artifact wins.
 */
export interface BuildPack {
  id: string;
  projectId: string;
  version: number;
  status: BuildPackStatus;
  siteBlueprintArtifactId: string | null;
  designSystemArtifactId: string | null;
  contentPackArtifactId: string | null;
  pages: BuildPackPage[];
  constraints: string[];
  permissions: PermissionLevel[];
  acceptanceCriteria: string[];
  evidenceRequirements: string[];
  /** Non-empty when status is CONFLICT — human attention required before proceeding. */
  conflicts: BuildPackConflict[];
  assembledByJobId: string | null;
  assembledAt: ISODate | null;
  supersededById: string | null;
  createdAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// Job pack (Part 7) — first-class renderable execution contract
// ---------------------------------------------------------------------------

/** One input artifact reference in a job pack (content excluded; only metadata travels). */
export interface JobPackArtifact {
  id: string;
  type: ArtifactType;
  version: number;
  title: string;
  summary: string | null;
  /** Char count of the full content, so recipients know what they are missing. */
  originalContentChars: number | null;
}

export interface JobPackLesson {
  id: string;
  title: string;
  content: string;
  scope: KnowledgeScope;
}

/**
 * A first-class renderable job pack (Part 7).
 * Can be transported through API, Claude subscription, ChatGPT, Gemini, Hermes, or human.
 * MUST NEVER contain secrets — enforced by secretScanStatus before export.
 */
export interface JobPack {
  id: string;
  jobId: string;
  projectId: string;
  ticketId: string | null;
  agentId: string;
  agentCode: AgentCode;
  /** What this agent is and what it exists to do. */
  agentCharter: string;
  /** Things this agent explicitly must not do beyond the permission model. */
  neverOwns: string[];
  /** Specific operating pass for Agent 03 (DIRECTION/COMPOSITION/VISUAL_REVIEW), or null for other agents. */
  operatingPass: AgentPass | null;
  skillId: string | null;
  skillVersion: number | null;
  /** Short human-readable project context card. Never the full knowledge dump. */
  projectBriefCard: string;
  inputArtifacts: JobPackArtifact[];
  approvedLessons: JobPackLesson[];
  constraints: string[];
  permissions: PermissionLevel[];
  task: string;
  outputSchema: string;
  validationRequirements: string[];
  evidenceExpectations: string[];
  /** Result of secret-pattern scanning before export. Must be "clean" to export. */
  secretScanStatus: "clean" | "flagged";
  secretScanIssues: string[];
  createdAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// Mode B — Assisted / External Subscription execution (Part 9)
// ---------------------------------------------------------------------------

export type ModeBStatus =
  | "PENDING_EXPORT"
  | "EXPORTED"
  | "PENDING_RESULT"
  | "RESULT_IMPORTED"
  | "RESULT_REJECTED"
  | "CANCELLED";

/**
 * Tracks the lifecycle of a Mode B job — when autonomous API execution failed or was bypassed
 * and the operator is manually running the job pack through an external assistant (Part 9).
 */
export interface ModeBJob {
  id: string;
  jobId: string;
  projectId: string;
  status: ModeBStatus;
  transport: Exclude<JobPackTransport, "API">;
  /** SHA-256 of the exported job pack, for integrity verification on import. */
  jobPackHash: string | null;
  jobPackId: string | null;
  exportedAt: ISODate | null;
  resultImportedAt: ISODate | null;
  resultRejectedReason: string | null;
  /** Operator who exported and imported. */
  operatorId: string | null;
  operatorName: string | null;
  createdAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// Provenance — full execution provenance on every run/artifact (Part 25)
// ---------------------------------------------------------------------------

export interface ProvenanceRecord {
  projectId: string;
  jobId: string;
  agentId: string;
  agentCode: AgentCode;
  provider: ProviderId | null;
  model: string | null;
  executionMode: ExecutionMode;
  transport: JobPackTransport;
  skillId: string | null;
  skillVersion: number | null;
  inputArtifactIds: string[];
  /** Evidence items (QA items, screenshots) referenced by the output artifact. */
  evidenceIds: string[];
  screenshotIds: string[];
  validationResult: ValidationResult | null;
  attemptCount: number;
  failedAttempts: number;
  fallbackReason: string | null;
  /** Operator who performed manual transport (Mode B/C). */
  operatorId: string | null;
  contextReductions: ContextReductionRecord[];
  retryTelemetry: RetryTelemetry | null;
  timestamp: ISODate;
}

// ---------------------------------------------------------------------------
// Client workflow primitives (Part 15)
// ---------------------------------------------------------------------------

export type IntakeStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE" | "BLOCKED";

export type ClientAssetStatus = "REQUESTED" | "RECEIVED" | "APPROVED" | "REJECTED";

export interface ClientAsset {
  id: string;
  projectId: string;
  name: string;
  description: string;
  status: ClientAssetStatus;
  /** Non-secret file reference (storage path or URL). */
  fileRef: string | null;
  requestedAt: ISODate | null;
  receivedAt: ISODate | null;
  approvedAt: ISODate | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Revision control (Part 16)
// ---------------------------------------------------------------------------

export type ChangeRequestClassification = "IN_SCOPE" | "OUT_OF_SCOPE" | "NEEDS_DECISION";

/** A structured change request produced from client feedback (Part 15/16). */
export interface ChangeRequest {
  id: string;
  projectId: string;
  revisionRoundId: string | null;
  title: string;
  description: string;
  classification: ChangeRequestClassification;
  /** Conductor may recommend classification; Production Lead confirms (Part 2). */
  recommendedByAgentId: string | null;
  classifiedByLeadId: string | null;
  classifiedByLeadName: string | null;
  confirmedAt: ISODate | null;
  ticketIds: string[];
  createdAt: ISODate | null;
}

/**
 * Tracks revision rounds for a project (Part 16).
 * Default commercial policy: 2 included rounds — overridable per project.
 * A third round creates an attention item requiring Production Lead decision.
 * CT-OS does not automatically refuse further work.
 */
export interface RevisionRound {
  id: string;
  projectId: string;
  roundNumber: number;
  requestSource: "client" | "internal" | "qa";
  ticketIds: string[];
  changeRequestIds: string[];
  scopeClassification: ChangeRequestClassification | null;
  approvedByLeadId: string | null;
  approvedByLeadName: string | null;
  approvedAt: ISODate | null;
  completedAt: ISODate | null;
  createdAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// Curation — Agent 08 event-triggered/scheduled (Part 24)
// ---------------------------------------------------------------------------

export type CurationDestinationType =
  | "skill"
  | "checklist"
  | "rubric"
  | "section_library"
  | "runbook";

export interface CurationDestinationProposal {
  type: CurationDestinationType;
  /** Existing skill/item id to update, or null for a new entry. */
  targetId: string | null;
  reason: string;
}

/**
 * A candidate lesson identified by Agent 08 (Part 24).
 * Must include evidence references — never promoted automatically.
 * Humans remain authoritative on all knowledge promotion.
 */
export interface CurationCandidate {
  id: string;
  /** null = agency-wide observation, not project-specific. */
  projectId: string | null;
  agentId: string;
  title: string;
  content: string;
  /** Ticket codes, artifact IDs, QA item IDs, benchmark run references. */
  evidenceRefs: string[];
  proposedScope: Exclude<KnowledgeScope, "TASK">;
  /** Number of projects this pattern was observed in. */
  observedProjectCount: number;
  confidence: number;
  destinationProposal: CurationDestinationProposal;
  status: "PENDING" | "PROMOTED" | "REJECTED" | "DEFERRED";
  reviewedById: string | null;
  reviewedByName: string | null;
  reviewedAt: ISODate | null;
  createdAt: ISODate | null;
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
  skills: Skill[];
  externalClients: ExternalClient[];
  externalAccessLog: ExternalAccessLogEntry[];
  // CTOS-005A additions (default to [] in all existing seeds/migrations)
  buildPacks: BuildPack[];
  revisionRounds: RevisionRound[];
  changeRequests: ChangeRequest[];
  clientAssets: ClientAsset[];
  curationCandidates: CurationCandidate[];
  screenshotEvidence: ScreenshotEvidence[];
  modeBJobs: ModeBJob[];
  // CTOS-005B additions (default to [] in all existing seeds/EMPTY objects)
  visualReferences: VisualReference[];
  signatureVisualElements: SignatureVisualElement[];
  sectionLibrary: SectionLibraryEntry[];
  designTokenSets: DesignTokenSet[];
  visualDefects: VisualDefect[];
  designContentReconciliations: DesignContentReconciliation[];
  // CTOS-006 additions (default to [] in all existing seeds/EMPTY objects)
  wpSiteConnections: WordPressSiteConnection[];
  websiteChangePlans: WebsiteChangePlan[];
  websiteRevisionSnapshots: WebsiteRevisionSnapshot[];
  websiteWriteResults: WebsiteWriteResult[];
  wpWriteAuditLog: WpWriteAuditEntry[];
  wpIdempotencyLog: WpIdempotencyRecord[];
}

// ---------------------------------------------------------------------------
// CTOS-005B: Visual Intelligence + Creative Director v0.2 + Builder Quality Foundation
// ---------------------------------------------------------------------------

// Console error record (moved here from qa-checks.ts for use in ExtendedScreenshotEvidence)
export type ConsoleErrorKind = "error" | "warning" | "info";
export interface ConsoleErrorRecord {
  kind: ConsoleErrorKind;
  message: string;
  source?: string;
  lineNumber?: number;
}

// Part 2 — Visual Design Rubric (18 dimensions, bounded 1–5 scores, verdicts A/B/C)
export type VisualRubricDimension =
  | "BRAND_ALIGNMENT"
  | "VISUAL_HIERARCHY"
  | "LAYOUT_COMPOSITION"
  | "SPACING_RHYTHM"
  | "TYPOGRAPHY"
  | "COLOR_USE"
  | "IMAGERY"
  | "NAVIGATION"
  | "CTA_CLARITY"
  | "CONVERSION_CLARITY"
  | "TRUST"
  | "CONTENT_CLARITY"
  | "RESPONSIVENESS"
  | "MOBILE_USABILITY"
  | "PRODUCT_PRESENTATION"
  | "ORIGINALITY"
  | "POLISH"
  | "TECHNICAL_VISUAL_DEFECTS";

export const VISUAL_RUBRIC_DIMENSIONS: VisualRubricDimension[] = [
  "BRAND_ALIGNMENT", "VISUAL_HIERARCHY", "LAYOUT_COMPOSITION", "SPACING_RHYTHM",
  "TYPOGRAPHY", "COLOR_USE", "IMAGERY", "NAVIGATION", "CTA_CLARITY", "CONVERSION_CLARITY",
  "TRUST", "CONTENT_CLARITY", "RESPONSIVENESS", "MOBILE_USABILITY", "PRODUCT_PRESENTATION",
  "ORIGINALITY", "POLISH", "TECHNICAL_VISUAL_DEFECTS",
];

// A = client-ready, B = polish pass needed (list exactly what), C = not ready (list why)
export type VisualRubricVerdict = "A" | "B" | "C";

export interface RubricScore {
  dimension: VisualRubricDimension;
  score: 1 | 2 | 3 | 4 | 5;
  verdict: VisualRubricVerdict;
  rationale: string;
  evidence: string[];
}

export interface VisualDesignRubricResult {
  projectId: string;
  jobId: string | null;
  scores: RubricScore[];
  overallVerdict: VisualRubricVerdict;
  // Dimensions scoring 1 — never averaged away, always surfaced explicitly
  criticalDimensions: VisualRubricDimension[];
  blockingIssues: string[];
  summary: string;
  assessedAt: ISODate | null;
}

// Part 3 — Anti-generic design rules
export interface AntiGenericRule {
  id: string;
  description: string;
  challengesPattern: string;
  preferredApproach: string;
}

// Part 4 — Signature visual element concept
export type SignatureVisualElementStatus = "PROPOSED" | "APPROVED" | "REJECTED";

export interface SignatureVisualElement {
  id: string;
  projectId: string;
  description: string;
  rationale: string;
  status: SignatureVisualElementStatus;
  proposedByAgentId: string | null;
  approvedBy: string | null;
  approvedAt: ISODate | null;
  createdAt: ISODate | null;
}

// Part 5 — Visual Reference System (human-curated, human-approval-gated; Part 22: safe modes)
export type VisualReferenceMode = "REPLICATE" | "MODERNIZE" | "REIMAGINE";

export interface VisualReference {
  id: string;
  projectId: string;
  url: string;
  title: string;
  description: string;
  mode: VisualReferenceMode;
  /** Always true — references must be human-curated; agents may propose but never add directly. */
  addedByHuman: boolean;
  approvedBy: string;
  approvedAt: ISODate | null;
  createdAt: ISODate | null;
}

// Part 6 — Extended screenshot evidence model (5 canonical viewports + DPR + scroll + source type)
export type ScreenshotViewport = 1440 | 1024 | 768 | 480 | 375;
export const SCREENSHOT_VIEWPORTS: ScreenshotViewport[] = [1440, 1024, 768, 480, 375];
export const REQUIRED_VIEWPORTS: ScreenshotViewport[] = [1440, 375]; // desktop + mobile required

export type ScreenshotSourceType = "CT_OS_CAPTURE" | "HUMAN_UPLOAD" | "TOOL_CAPTURE";

export interface ExtendedScreenshotEvidence {
  id: string;
  projectId: string;
  jobId: string | null;
  url: string;
  viewport: ScreenshotViewport;
  widthPx: number;
  heightPx: number;
  dpr: number;
  scrollPosition: number;
  sourceType: ScreenshotSourceType;
  capturedAt: ISODate | null;
  captureStatus: "captured" | "failed" | "pending";
  consoleErrors: ConsoleErrorRecord[];
  loadErrors: string[];
}

// Part 7 — Screenshot set validation
export type ScreenshotSetIssueKind =
  | "missing_desktop"
  | "missing_mobile"
  | "failed_capture"
  | "mismatch"
  | "duplicate_viewport"
  | "stale_evidence";

export interface ScreenshotSetIssue {
  kind: ScreenshotSetIssueKind;
  viewport?: ScreenshotViewport;
  detail: string;
}

export interface ScreenshotSetValidationResult {
  valid: boolean;
  issues: ScreenshotSetIssue[];
  coverage: ScreenshotViewport[];
  missingViewports: ScreenshotViewport[];
}

// Part 8 — Visual comparison types
export type VisualComparisonKind =
  | "CURRENT_VS_REFERENCE"
  | "BEFORE_VS_AFTER"
  | "DESKTOP_VS_MOBILE"
  | "BUILD_VS_COMPOSITION"
  | "REVISION_VS_PREVIOUS";

export type VisualComparisonFindingKind =
  | "missing_section"
  | "geometry_diff"
  | "hierarchy_mismatch"
  | "color_inconsistency"
  | "typography_inconsistency"
  | "spacing_inconsistency"
  | "content_mismatch"
  | "layout_broken";

export interface VisualComparisonFinding {
  kind: VisualComparisonFindingKind;
  description: string;
  severity: QASeverity;
  viewport?: ScreenshotViewport;
}

export interface VisualComparison {
  id: string;
  projectId: string;
  jobId: string | null;
  kind: VisualComparisonKind;
  findings: VisualComparisonFinding[];
  summary: string;
  createdAt: ISODate | null;
}

// Parts 11–13 — Section Library data model + build strategy + novelty governance
export type SectionLibraryStatus = "CANDIDATE" | "APPROVED" | "DEPRECATED";
export type BuildStrategy = "LIBRARY_ASSEMBLY" | "NATIVE_NOVEL_BUILD";

export interface SectionLibraryEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  status: SectionLibraryStatus;
  buildStrategy: BuildStrategy;
  /** Required when buildStrategy is NATIVE_NOVEL_BUILD — must justify why library is insufficient. */
  noveltyJustification?: string;
  evidence: string[];
  approvedBy: string | null;
  approvedAt: ISODate | null;
  createdAt: ISODate | null;
}

// Part 14 — Design tokens
export type DesignTokenKind =
  | "color"
  | "typography"
  | "spacing"
  | "border_radius"
  | "shadow"
  | "container_width"
  | "breakpoint"
  | "button"
  | "form"
  | "image_treatment"
  | "icon_treatment";

export interface DesignToken {
  key: string;
  value: string;
  kind: DesignTokenKind;
  usage: string;
}

export interface DesignTokenSet {
  id: string;
  projectId: string;
  version: number;
  tokens: DesignToken[];
  approvedBy: string | null;
  approvedAt: ISODate | null;
  createdAt: ISODate | null;
}

// Part 17 — Design↔Content reconciliation
export type ReconciliationStatus =
  | "OPEN"
  | "RESOLVED_BY_CONTENT"
  | "RESOLVED_BY_DESIGN"
  | "NEEDS_HUMAN";

export interface DesignContentReconciliation {
  id: string;
  projectId: string;
  description: string;
  status: ReconciliationStatus;
  designArtifactId: string | null;
  contentArtifactId: string | null;
  resolvedBy: string | null;
  resolvedAt: ISODate | null;
  createdAt: ISODate | null;
}

// Part 20 — Visual defect model (typed categories, canonical severity)
export type VisualDefectCategory =
  | "LAYOUT"
  | "SPACING"
  | "TYPOGRAPHY"
  | "COLOR"
  | "IMAGE"
  | "OVERFLOW"
  | "ALIGNMENT"
  | "RESPONSIVE"
  | "NAVIGATION"
  | "CTA"
  | "CONTENT_PRESENTATION"
  | "BRAND"
  | "ACCESSIBILITY_VISUAL"
  | "GENERIC_DESIGN"
  | "IMPLEMENTATION_MISMATCH";

export interface VisualDefect {
  id: string;
  projectId: string;
  jobId: string | null;
  category: VisualDefectCategory;
  severity: QASeverity;
  description: string;
  evidence: string[];
  viewport?: ScreenshotViewport;
  status: QAItemStatus;
  detectedByAgentId: string | null;
  createdAt: ISODate | null;
  resolvedAt: ISODate | null;
}

// Part 23 — Evidence-grounded claims (OBSERVED/INFERRED/PROPOSED/VERIFIED)
export type EvidenceClaimKind = "OBSERVED" | "INFERRED" | "PROPOSED" | "VERIFIED";

export interface EvidenceClaim {
  id: string;
  kind: EvidenceClaimKind;
  claim: string;
  evidence: string[];
  confidence: number;
  madeByAgentId: string | null;
  jobId: string | null;
  createdAt: ISODate | null;
}

// ---------------------------------------------------------------------------
// CTOS-006: Controlled WordPress / Elementor Write Engine
// ---------------------------------------------------------------------------

// Part 1 — Site connection model
export type WpEnvironment = "LOCAL" | "DEV" | "STAGING" | "PRODUCTION";
export type WpCmsBuilder = "ELEMENTOR" | "ELEMENTOR_PRO" | "GUTENBERG" | "UNKNOWN";
export type WpConnectionStatus = "UNCHECKED" | "ONLINE" | "OFFLINE" | "AUTH_FAILED" | "DECOMMISSIONED";
export type WpConnectionCapability =
  | "read_content"
  | "write_draft"
  | "write_published"
  | "read_elementor"
  | "write_elementor"
  | "create_revision"
  | "restore_revision"
  | "read_media"
  | "write_media";

/** Non-secret WordPress site binding. Credential values NEVER stored here — only a vault-key reference. */
export interface WordPressSiteConnection {
  id: string;
  projectId: string;
  siteUrl: string;
  environment: WpEnvironment;
  cms: "WORDPRESS";
  builder: WpCmsBuilder;
  /** Auth mechanism name only — never the credential value. */
  authMethod: "application_password" | "jwt" | "ct_bridge" | "none";
  /** Vault/env-var key pointing to where the credential lives. Never the credential itself. */
  credentialsRef: string | null;
  connectionStatus: WpConnectionStatus;
  lastVerifiedAt: ISODate | null;
  capabilities: WpConnectionCapability[];
  writeable: boolean;
  ownershipNote: string | null;
  /** e.g. "Hostinger". Stored so migration can be planned without hardcoding it. */
  hostProvider: string | null;
  /** When true, the host can be swapped without changing project identity or write provenance. */
  hostReplaceable: boolean;
  createdAt: ISODate | null;
  updatedAt: ISODate | null;
}

// Part 4 — Write action taxonomy
export type WpWriteActionType =
  // Content
  | "UPDATE_HEADING"
  | "UPDATE_TEXT"
  | "UPDATE_BUTTON_LABEL"
  | "UPDATE_BUTTON_URL"
  // Media
  | "REPLACE_IMAGE"
  // Elementor
  | "UPDATE_WIDGET_CONTENT"
  | "UPDATE_WIDGET_STYLE_SAFE"
  | "UPDATE_CONTAINER_SETTINGS_SAFE"
  | "ADD_APPROVED_SECTION"
  | "REMOVE_DRAFT_SECTION"
  | "REORDER_DRAFT_SECTIONS"
  // Page
  | "CREATE_DRAFT_PAGE"
  | "UPDATE_PAGE_TITLE"
  | "UPDATE_PAGE_SLUG_DRAFT"
  | "UPDATE_META_DESCRIPTION";

// Part 7 — Deterministic target resolution
export interface WpTargetRef {
  pageId: string | null;
  templateId: string | null;
  elementorElementId: string | null;
  widgetId: string | null;
  containerId: string | null;
  sectionSemanticKey: string | null;
  contentSlotKey: string | null;
}

// Part 8 — Preconditions for compare-and-swap safety
export type WpPreconditionKind = "document_revision" | "page_modified_ts" | "elementor_hash" | "content_value" | "widget_identity";
export interface WpPrecondition {
  kind: WpPreconditionKind;
  expectedValue: string;
}

// Write action record
export interface WpWriteAction {
  id: string;
  type: WpWriteActionType;
  permissionLevel: PermissionLevel;
  target: WpTargetRef;
  preconditions: WpPrecondition[];
  /** Type-safe payload varies per action type; kept as Record for forward-compat. */
  payload: Record<string, unknown>;
  /** Deterministic key preventing duplicate execution of the same action. */
  idempotencyKey: string;
}

// Part 6 — Change plan
export type WpChangePlanStatus =
  | "DRAFT"
  | "READY"
  | "EXECUTING"
  | "COMPLETED"
  | "FAILED"
  | "ROLLED_BACK"
  | "SUPERSEDED";

export interface WebsiteChangePlan {
  id: string;
  projectId: string;
  siteConnectionId: string;
  environment: WpEnvironment;
  sourceRequest: string;
  buildPackId: string | null;
  elementorManifestArtifactId: string | null;
  targetPageId: string | null;
  targetPageTitle: string | null;
  actions: WpWriteAction[];
  /** Highest permission tier across all actions — gates human approval requirement. */
  overallPermissionTier: PermissionLevel;
  backupRequired: boolean;
  verificationRequired: boolean;
  screenshotRequired: boolean;
  rollbackStrategy: string;
  humanApprovalsRequired: string[];
  risks: string[];
  status: WpChangePlanStatus;
  approvedById: string | null;
  approvedAt: ISODate | null;
  executingJobId: string | null;
  createdByJobId: string | null;
  provenance: string;
  createdAt: ISODate | null;
  updatedAt: ISODate | null;
}

// Part 9 — Revision snapshot (rollback anchor)
export interface WebsiteRevisionSnapshot {
  id: string;
  projectId: string;
  siteConnectionId: string;
  pageId: string;
  environment: WpEnvironment;
  capturedAt: ISODate | null;
  /** WordPress revision ID at capture time. */
  sourceRevision: string | null;
  /** Storage pointer to the Elementor document blob — never inline in OSData. */
  elementorDocumentRef: string | null;
  pageContentRef: string | null;
  contentHash: string | null;
  originatingJobId: string | null;
  originatingChangePlanId: string | null;
  /**
   * Raw Elementor nodes captured before a write (bridge GET elementor_data).
   * Stored inline for MVP rollback — this is the payload sent to the bridge rollback endpoint.
   * Never derived by reconstructing from typed nodes: round-trip JSON key ordering
   * must match the PHP-computed snapshot_hash exactly.
   */
  elementorSnapshotRaw: unknown[] | null;
  /** PHP-computed SHA-256 hash of the snapshot (document_hash from bridge GET). */
  elementorSnapshotHash: string | null;
}

// Part 11 — Write result
export type WpWriteResultStatus =
  | "SUCCEEDED_VERIFIED"
  | "FAILED_CONNECTION"
  | "FAILED_PERMISSION"
  | "FAILED_VALIDATION"
  | "CONFLICT_DETECTED"
  | "FAILED_WRITE"
  | "FAILED_READBACK"
  | "FAILED_ROLLBACK"
  | "NEEDS_A_HAND";

export interface WpActionResult {
  actionId: string;
  type: WpWriteActionType;
  status: "SUCCEEDED" | "FAILED" | "SKIPPED" | "CONFLICT";
  beforeValue: unknown;
  afterValue: unknown;
  error: string | null;
  verificationPassed: boolean | null;
}

export interface WebsiteWriteResult {
  id: string;
  changePlanId: string;
  projectId: string;
  siteConnectionId: string;
  status: WpWriteResultStatus;
  actionResults: WpActionResult[];
  beforeSnapshotId: string | null;
  afterStateHash: string | null;
  verificationResults: { field: string; expected: string; actual: string; match: boolean }[];
  startedAt: ISODate | null;
  completedAt: ISODate | null;
  transport: "REST_API" | "CT_BRIDGE" | "FAKE";
  actorId: string | null;
  actorName: string | null;
  errors: string[];
  rollbackStatus: "NOT_NEEDED" | "COMPLETED" | "FAILED" | "NOT_ATTEMPTED" | null;
  provenance: string;
}

// Part 33 — Audit log (NEVER contains raw auth headers, passwords, tokens, nonces, cookies)
export interface WpWriteAuditEntry {
  id: string;
  projectId: string;
  siteConnectionId: string;
  environment: WpEnvironment;
  changePlanId: string | null;
  writeResultId: string | null;
  requestedById: string | null;
  requestedByName: string | null;
  permissionLevel: PermissionLevel;
  approvalId: string | null;
  actionTypes: WpWriteActionType[];
  transport: "REST_API" | "CT_BRIDGE" | "FAKE";
  timestamp: ISODate;
  beforeSnapshotId: string | null;
  result: WpWriteResultStatus | null;
  verificationPassed: boolean | null;
  rollbackPerformed: boolean;
}

// Part 12 — Idempotency
export interface WpIdempotencyRecord {
  id: string;
  idempotencyKey: string;
  changePlanId: string;
  projectId: string;
  appliedAt: ISODate;
  resultId: string;
}

// Part 14 — Minimal Elementor document model (only what is needed for safe patching)
export type ElementorNodeType =
  | "container"
  | "heading"
  | "text"
  | "image"
  | "button"
  | "icon"
  | "spacer"
  | "form_ref"
  | "woo_widget_ref"
  | "unknown";

export interface ElementorNode {
  id: string;
  type: ElementorNodeType;
  /** Known/safe settings only. Unknown fields are preserved in _preserved. */
  settings: Record<string, unknown>;
  children: ElementorNode[];
  /** All unknown/unsupported Elementor fields preserved here to prevent accidental data loss. */
  _preserved: Record<string, unknown>;
}

export interface ElementorDocument {
  pageId: string;
  version: string;
  /** SHA-256 of the canonical document JSON — used for precondition checks. */
  documentHash: string;
  nodes: ElementorNode[];
}

// Part 14b — CT Bridge targeted patch contract
// These are the ONLY operations accepted by the PATCH bridge endpoint.
export type ElementorMvpOperation =
  | "SET_WIDGET_TEXT"
  | "SET_WIDGET_LINK"
  | "SET_IMAGE"
  | "SET_SETTING";

/**
 * Targeted patch sent to POST /ctos/v1/elementor/{pageId} (bridge PATCH endpoint).
 * Mutates exactly ONE setting on ONE element. No full-document replacement.
 */
export interface ElementorBridgePatch {
  expectedDocumentHash: string;
  operation: ElementorMvpOperation;
  elementId: string;
  expectedElementType: ElementorNodeType;
  expectedCurrentValue?: unknown;
  /** Required for SET_SETTING — must be in the safe style whitelist. */
  key?: string;
  value: unknown;
}

/**
 * Payload sent to POST /ctos/v1/elementor/{pageId}/rollback.
 * Gated by snapshot integrity (elementorData must hash to snapshotHash)
 * and conflict protection (expectedCurrentHash must match live document).
 */
export interface ElementorBridgeRollback {
  /** PHP-computed SHA-256 the snapshot data must reproduce. */
  snapshotHash: string;
  /** Current document hash — prevents overwriting concurrent human edits. */
  expectedCurrentHash: string;
  /** Raw Elementor nodes from the original bridge GET snapshot. */
  elementorData: unknown[];
}

// Part 15 — Elementor patch operations
export type ElementorPatchOpType =
  | "SET_WIDGET_TEXT"
  | "SET_WIDGET_LINK"
  | "SET_IMAGE"
  | "SET_SETTING"
  | "ADD_CHILD"
  | "REMOVE_CHILD"
  | "MOVE_CHILD";

/** Safe Elementor style settings permitted under GREEN actions. */
export type SafeStyleSettingKey =
  | "text_align"
  | "color"
  | "background_color"
  | "margin"
  | "padding"
  | "border_radius"
  | "typography_font_size"
  | "typography_font_weight"
  | "width"
  | "height"
  | "responsive_visibility"
  | "flex_justify_content"
  | "flex_align_items";

export interface ElementorPatchOp {
  id: string;
  op: ElementorPatchOpType;
  targetElementId: string;
  expectedElementType: ElementorNodeType;
  expectedCurrentValue?: unknown;
  newValue?: unknown;
  /** Only for SET_SETTING — must be in SafeStyleSettingKey for GREEN; custom CSS is AMBER minimum. */
  settingKey?: string;
  permissionLevel: PermissionLevel;
  sourcePlanId: string;
}

// Part 23 — Diff model
export interface WpContentDiff {
  field: string;
  old: string;
  new: string;
}

export interface WpElementorPropertyDiff {
  nodeId: string;
  nodeType: ElementorNodeType;
  property: string;
  before: unknown;
  after: unknown;
}

export type WpStructuralChangeKind = "added_section" | "removed_section" | "moved_section";

export interface WpStructuralChange {
  kind: WpStructuralChangeKind;
  sectionId: string;
  sectionName: string;
  position?: number;
}

export interface WpDiffModel {
  contentDiffs: WpContentDiff[];
  elementorDiffs: WpElementorPropertyDiff[];
  structuralChanges: WpStructuralChange[];
}

// Part 30 — U-Proof site connection onboarding checklist
export interface WpConnectionChecklistItem {
  key: string;
  description: string;
  required: boolean;
  complete: boolean;
  completedAt: ISODate | null;
}

export interface WpSiteConnectionChecklist {
  siteConnectionId: string;
  projectId: string;
  items: WpConnectionChecklistItem[];
  launchHoldIds: string[];
  createdAt: ISODate | null;
}

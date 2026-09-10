/**
 * Job-pack service (CTOS-005A Part 7).
 *
 * Assembles a first-class renderable JobPack from an AgentJob.
 * The same logical pack is transportable through API, external subscription, or human.
 * Secret-pattern scanning is mandatory before export (Part 29).
 */
import type {
  AgentJob,
  AgentPass,
  Artifact,
  JobPack,
  JobPackArtifact,
  JobPackLesson,
  KnowledgeItem,
  OSData,
} from "@/data/types";
import { newId, nowIso } from "@/lib/core";
import { approvedSkillsForAgent } from "./skills";
import { knowledgeForJob } from "./knowledge";

// ---------------------------------------------------------------------------
// Secret scanning (Part 29) — Mode B export must be tested for secret leakage
// ---------------------------------------------------------------------------

/**
 * Patterns that may indicate a secret.
 * Conservative: prefers false positives over false negatives for export blocking.
 */
const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "api_key_assignment", pattern: /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}/i },
  { name: "bearer_token", pattern: /bearer\s+[A-Za-z0-9._-]{16,}/i },
  { name: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/i },
  { name: "openai_key", pattern: /sk-[A-Za-z0-9]{32,}/i },
  { name: "gemini_key", pattern: /AIza[A-Za-z0-9_-]{35}/i },
  { name: "password_field", pattern: /password\s*[:=]\s*["'][^"']{6,}/i },
  { name: "secret_field", pattern: /secret\s*[:=]\s*["'][^"']{6,}/i },
  { name: "connection_string", pattern: /(?:mysql|postgres|mongodb):\/\/[^@\s]+:[^@\s]+@/i },
  { name: "token_field", pattern: /(?:access_token|auth_token|session_token)\s*[:=]\s*["'][^"']{8,}/i },
  { name: "private_key_header", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

export interface SecretScanResult {
  clean: boolean;
  issues: string[];
}

/** Scan text for secret patterns. Never logs the matched value — only the pattern name and position. */
export function scanForSecrets(text: string): SecretScanResult {
  const issues: string[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      issues.push(`Potential secret detected: pattern "${name}" matched near position ${match.index}`);
    }
  }
  return { clean: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function artifactRef(a: Artifact): JobPackArtifact {
  const contentJson = a.content !== undefined ? JSON.stringify(a.content) : null;
  return {
    id: a.id,
    type: a.type,
    version: a.version,
    title: a.title,
    summary: a.summary ?? null,
    originalContentChars: contentJson ? contentJson.length : null,
  };
}

function lessonRef(k: KnowledgeItem): JobPackLesson {
  return { id: k.id, title: k.title, content: k.content, scope: k.scope };
}

/**
 * Assemble a JobPack for a job.
 * The pack is a renderable snapshot — it does not contain live secrets.
 * Call exportJobPack() after assembly to get the export-safe version with scan results.
 */
export function assembleJobPack(data: OSData, jobId: string): { data: OSData; jobPack: JobPack } {
  const job = data.agentJobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  const agent = data.agents.find((a) => a.id === job.agentId);
  if (!agent) throw new Error(`Agent ${job.agentId} not found`);

  const inputArtifacts = job.inputArtifactIds
    .map((id) => data.artifacts.find((a) => a.id === id))
    .filter((a): a is Artifact => !!a);

  const approvedSkills = approvedSkillsForAgent(data, job.agentId, agent.instructionPackIds ?? []);
  const allSkills = data.skills.filter((s) => approvedSkills.some((as) => as.id === s.id));
  const knowledge = knowledgeForJob(data, job.projectId, job.id);

  const project = data.projects.find((p) => p.id === job.projectId);
  const projectBriefCard = project
    ? `Project: ${project.name} (${project.type}) | Platform: ${project.platformSummary} | State: ${project.state} | Goal: ${project.primaryGoal ?? "not set"}`
    : `Project ID: ${job.projectId}`;

  const packId = newId("jp");
  const jobPack: JobPack = {
    id: packId,
    jobId: job.id,
    projectId: job.projectId,
    ticketId: job.ticketId ?? null,
    agentId: agent.id,
    agentCode: agent.code,
    agentCharter: [
      `${agent.code} ${agent.name} — ${agent.role}.`,
      `Responsibilities: ${agent.responsibilities.join(", ")}.`,
      agent.mission ? `Mission: ${agent.mission}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    neverOwns: agent.exclusions ?? [],
    operatingPass: inferAgentPass(job),
    skillId: allSkills[0]?.id ?? null,
    skillVersion: allSkills[0]?.version ?? null,
    projectBriefCard,
    inputArtifacts: inputArtifacts.map(artifactRef),
    approvedLessons: knowledge.map(lessonRef),
    constraints: [`Permission level: ${job.permissionLevel}. Do not exceed it.`, `Output schema: ${job.requiredOutputSchema}.`],
    permissions: [job.permissionLevel],
    task: job.instructions,
    outputSchema: job.requiredOutputSchema,
    validationRequirements: [`Output must satisfy "${job.requiredOutputSchema}" Zod schema`, "All required fields must be present"],
    evidenceExpectations: [],
    secretScanStatus: "clean", // updated by scanJobPack()
    secretScanIssues: [],
    createdAt: nowIso(),
  };

  return { data, jobPack };
}

/** Infer the agent pass from a job's task type (for Agent 03). */
function inferAgentPass(job: AgentJob): AgentPass | null {
  if (job.taskType === "design_direction") return "DIRECTION";
  if (job.taskType === "composition") return "COMPOSITION";
  if (job.taskType === "visual_review") return "VISUAL_REVIEW";
  return null;
}

/**
 * Scan a job pack for secrets before export (Part 29).
 * Returns a clean pack (secretScanStatus: "clean") or a flagged pack with issues listed.
 * A flagged pack MUST NOT be exported.
 */
export function scanJobPack(jobPack: JobPack): JobPack {
  const serialized = JSON.stringify(jobPack);
  const result = scanForSecrets(serialized);
  return { ...jobPack, secretScanStatus: result.clean ? "clean" : "flagged", secretScanIssues: result.issues };
}

/**
 * Prepare a job pack for Mode B export.
 * 1. Runs the secret scan.
 * 2. Throws if the scan is flagged (never export a pack containing secrets).
 * 3. Returns the serialisable pack ready for clipboard or file transport.
 */
export function exportJobPack(jobPack: JobPack): JobPack {
  const scanned = scanJobPack(jobPack);
  if (scanned.secretScanStatus === "flagged") {
    throw new Error(
      `Job pack secret scan failed. Cannot export. Issues: ${scanned.secretScanIssues.join("; ")}`,
    );
  }
  return scanned;
}

/**
 * Validate an imported Mode B result against the expected output schema.
 * Preserves job identity, agent identity, skill version, and project scope.
 * Returns validation issues; an empty array means the import is safe.
 */
export interface ImportValidationResult {
  ok: boolean;
  issues: string[];
  parsedOutput: unknown;
}

export function validateModeBImport(
  jobPackId: string,
  importedOutput: unknown,
  expectedSchema: string,
  validateFn: (schema: string, output: unknown) => { ok: boolean; issues: { path: string; message: string }[] },
): ImportValidationResult {
  const vr = validateFn(expectedSchema, importedOutput);
  if (!vr.ok) {
    return {
      ok: false,
      issues: [
        `Schema validation failed for "${expectedSchema}" (job pack ${jobPackId}):`,
        ...vr.issues.map((i) => `  ${i.path}: ${i.message}`),
      ],
      parsedOutput: null,
    };
  }
  return { ok: true, issues: [], parsedOutput: importedOutput };
}

/**
 * Artifact system.
 *
 * Agents communicate through structured, versioned artifacts — not chat history.
 * Every function here is pure: it takes OSData and returns a new OSData (plus the
 * created record), so the store reducer, the Supabase writer and the tests share
 * exactly one implementation.
 */
import type { Artifact, ArtifactStatus, ArtifactType, OSData, ProviderId } from "@/data/types";
import { newId, nowIso } from "@/lib/core";

export interface ArtifactTypeDef {
  type: ArtifactType;
  label: string;
  /** Current structured-payload schema version for this type. */
  schemaVersion: number;
  description: string;
}

export const ARTIFACT_TYPES: ArtifactTypeDef[] = [
  { type: "project_brief", label: "Project Brief", schemaVersion: 1, description: "Goal, scope, constraints and client context for a project." },
  { type: "research_report", label: "Research Report", schemaVersion: 1, description: "Business, existing-site and competitor intelligence." },
  { type: "site_blueprint", label: "Site Blueprint", schemaVersion: 1, description: "Sitemap, customer journeys, information architecture and conversion logic." },
  { type: "design_system", label: "Design System", schemaVersion: 1, description: "Visual direction, layout system, tokens and imagery direction." },
  { type: "content_pack", label: "Content Pack", schemaVersion: 1, description: "SEO architecture, page copy, metadata and internal linking." },
  { type: "build_plan", label: "Build Plan", schemaVersion: 1, description: "Ordered build tickets with scope and do-not-change lists." },
  { type: "build_report", label: "Build Report", schemaVersion: 1, description: "What was built, where (preview/template ids), and what was verified." },
  { type: "qa_report", label: "QA Report", schemaVersion: 1, description: "Defects by severity with evidence, plus launch readiness." },
  { type: "client_feedback", label: "Client Feedback", schemaVersion: 1, description: "Structured client feedback captured against pages or artifacts." },
  { type: "deployment_report", label: "Deployment Report", schemaVersion: 1, description: "Backups, migration steps, activation results and rollback state." },
  { type: "lesson_candidate", label: "Lesson Candidate", schemaVersion: 1, description: "Proposed lessons with evidence, for human review in Knowledge." },
  { type: "website_audit_report", label: "Website Audit Report", schemaVersion: 1, description: "Public-prospect or deep-audit findings across Traffic, Message, Trust, Conversion and Follow-up." },
  { type: "audit_capture", label: "Audit Capture", schemaVersion: 1, description: "Public-site capture evidence: per-page digests (title, headings, links, CTAs, forms, scripts) — never raw HTML." },
  { type: "audit_discovery", label: "Audit Discovery", schemaVersion: 1, description: "A01 discovery: business type, audience signals, site structure and technical signals." },
  { type: "audit_architecture", label: "Audit Architecture", schemaVersion: 1, description: "A02 UX/IA analysis: navigation, information architecture and UX findings." },
  { type: "audit_creative", label: "Audit Creative", schemaVersion: 1, description: "A03 creative analysis: visual observations and creative findings (structural only when screenshots unavailable)." },
  { type: "audit_content_analysis", label: "Audit Content Analysis", schemaVersion: 1, description: "A04 content analysis: messaging, SEO signals and content findings." },
  { type: "audit_qa_review", label: "Audit QA Review", schemaVersion: 1, description: "A06 QA review: challenged and confirmed findings plus quality score." },
  { type: "other", label: "Other", schemaVersion: 1, description: "Anything that does not fit a defined type." },
];

export const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = Object.fromEntries(ARTIFACT_TYPES.map((t) => [t.type, t.label])) as Record<ArtifactType, string>;

export function schemaVersionFor(type: ArtifactType): number {
  return ARTIFACT_TYPES.find((t) => t.type === type)?.schemaVersion ?? 1;
}

/** Output schema name a job must satisfy for a given artifact type, e.g. "site_blueprint@1". */
export function outputSchemaFor(type: ArtifactType): string {
  return `${type}@${schemaVersionFor(type)}`;
}

export interface CreateArtifactInput {
  projectId: string;
  type: ArtifactType;
  title: string;
  createdByAgentId: string | null;
  createdByProvider?: ProviderId | null;
  ticketId?: string;
  jobId?: string;
  status?: ArtifactStatus;
  storageLocation?: string | null;
  summary?: string;
  content?: unknown;
  id?: string;
  at?: string;
}

/** Create version 1 of a new artifact lineage. */
export function createArtifact(data: OSData, input: CreateArtifactInput): { data: OSData; artifact: Artifact } {
  const at = input.at ?? nowIso();
  const artifact: Artifact = {
    id: input.id ?? newId("art"),
    projectId: input.projectId,
    type: input.type,
    title: input.title,
    version: 1,
    createdByAgentId: input.createdByAgentId,
    createdByProvider: input.createdByProvider ?? null,
    ticketId: input.ticketId,
    jobId: input.jobId,
    status: input.status ?? "DRAFT",
    storageLocation: input.storageLocation ?? null,
    schemaVersion: schemaVersionFor(input.type),
    supersedesArtifactId: null,
    summary: input.summary,
    content: input.content,
    createdAt: at,
    updatedAt: at,
  };
  return { data: { ...data, artifacts: [...data.artifacts, artifact] }, artifact };
}

export interface CreateVersionInput {
  previousArtifactId: string;
  createdByAgentId: string | null;
  createdByProvider?: ProviderId | null;
  title?: string;
  ticketId?: string;
  jobId?: string;
  status?: ArtifactStatus;
  storageLocation?: string | null;
  summary?: string;
  content?: unknown;
  id?: string;
  at?: string;
}

/**
 * Create the next version of an existing artifact. The previous artifact is marked
 * SUPERSEDED and the new one points back via `supersedesArtifactId`.
 */
export function createArtifactVersion(data: OSData, input: CreateVersionInput): { data: OSData; artifact: Artifact } {
  const previous = data.artifacts.find((a) => a.id === input.previousArtifactId);
  if (!previous) throw new Error(`Artifact ${input.previousArtifactId} not found`);
  if (previous.status === "SUPERSEDED") throw new Error(`Artifact ${previous.id} is already superseded — version from the latest artifact instead`);
  const at = input.at ?? nowIso();
  const artifact: Artifact = {
    ...previous,
    id: input.id ?? newId("art"),
    title: input.title ?? previous.title,
    version: previous.version + 1,
    createdByAgentId: input.createdByAgentId,
    createdByProvider: input.createdByProvider ?? null,
    ticketId: input.ticketId ?? previous.ticketId,
    jobId: input.jobId,
    status: input.status ?? "DRAFT",
    storageLocation: input.storageLocation ?? null,
    schemaVersion: schemaVersionFor(previous.type),
    supersedesArtifactId: previous.id,
    summary: input.summary ?? previous.summary,
    content: input.content,
    createdAt: at,
    updatedAt: at,
  };
  const artifacts = data.artifacts.map((a) => (a.id === previous.id ? { ...a, status: "SUPERSEDED" as const, updatedAt: at } : a)).concat(artifact);
  return { data: { ...data, artifacts }, artifact };
}

export function setArtifactStatus(data: OSData, artifactId: string, status: ArtifactStatus): OSData {
  const at = nowIso();
  return { ...data, artifacts: data.artifacts.map((a) => (a.id === artifactId ? { ...a, status, updatedAt: at } : a)) };
}

/** Latest (non-superseded) artifact of a type on a project, if any. */
export function latestArtifact(data: OSData, projectId: string, type: ArtifactType): Artifact | null {
  const candidates = data.artifacts.filter((a) => a.projectId === projectId && a.type === type && a.status !== "SUPERSEDED");
  if (!candidates.length) return null;
  return candidates.reduce((best, a) => (a.version > best.version ? a : best));
}

/** Follow `supersedesArtifactId` back to version 1. Newest first. */
export function artifactLineage(data: OSData, artifactId: string): Artifact[] {
  const out: Artifact[] = [];
  let current = data.artifacts.find((a) => a.id === artifactId) ?? null;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    out.push(current);
    const prevId: string | null = current.supersedesArtifactId;
    current = prevId ? (data.artifacts.find((a) => a.id === prevId) ?? null) : null;
  }
  return out;
}

/**
 * Build-pack assembler (CTOS-005A Part 5).
 *
 * Assembles the single authoritative build contract (BuildPack) that Agent 05 consumes.
 * FAILS CLOSED on conflicts — Agent 05 never decides which conflicting artifact wins.
 * All conflicts must be resolved by a human before the pack can be marked READY.
 */
import type {
  Artifact,
  BuildPack,
  BuildPackConflict,
  BuildPackPage,
  OSData,
  PermissionLevel,
} from "@/data/types";
import { newId, nowIso } from "@/lib/core";

type SiteBlueprintContent = {
  sitemap?: { title: string; path: string; purpose: string; children?: { title: string; path: string }[] }[];
  summary?: string;
};
type ContentPackContent = {
  pages?: { path: string; title: string; metaDescription: string; h1: string; sections: string[] }[];
};

function latestApprovedArtifact(data: OSData, projectId: string, type: Artifact["type"]): Artifact | null {
  return (
    data.artifacts
      .filter((a) => a.projectId === projectId && a.type === type && a.status === "FINAL")
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

function crossProjectCheck(projectId: string, artifactIds: (string | null)[], data: OSData): BuildPackConflict[] {
  const conflicts: BuildPackConflict[] = [];
  for (const id of artifactIds) {
    if (!id) continue;
    const art = data.artifacts.find((a) => a.id === id);
    if (art && art.projectId !== projectId) {
      conflicts.push({
        kind: "cross_project_artifact",
        detail: `Artifact ${id} belongs to project ${art.projectId}, not ${projectId}. Build packs must only reference artifacts from their own project.`,
        artifactIds: [id],
      });
    }
  }
  return conflicts;
}

/**
 * Assemble a BuildPack for a project.
 *
 * Returns a READY pack when all upstream artifacts are present and consistent.
 * Returns a CONFLICT pack (with a non-empty conflicts array) when any inconsistency is found —
 * the caller must surface this to the operator; Agent 05 must not proceed until resolved.
 */
export function assembleBuildPack(
  data: OSData,
  projectId: string,
  opts: { jobId?: string; permissions?: PermissionLevel[] } = {},
): { data: OSData; buildPack: BuildPack } {
  const at = nowIso();
  const conflicts: BuildPackConflict[] = [];

  // Retrieve approved upstream artifacts
  const blueprint = latestApprovedArtifact(data, projectId, "site_blueprint");
  const designSystem = latestApprovedArtifact(data, projectId, "design_system");
  const contentPack = latestApprovedArtifact(data, projectId, "content_pack");

  // Cross-project safety check
  conflicts.push(
    ...crossProjectCheck(projectId, [blueprint?.id ?? null, designSystem?.id ?? null, contentPack?.id ?? null], data),
  );

  // Required artifact presence
  if (!blueprint) {
    conflicts.push({
      kind: "missing_required_content",
      detail: "No approved site_blueprint artifact found for this project.",
      artifactIds: [],
    });
  }
  if (!contentPack) {
    conflicts.push({
      kind: "missing_required_content",
      detail: "No approved content_pack artifact found for this project.",
      artifactIds: [],
    });
  }

  // Build pages from blueprint sitemap + content pack pages
  const pages: BuildPackPage[] = [];
  if (blueprint && contentPack) {
    const bp = blueprint.content as SiteBlueprintContent | undefined;
    const cp = contentPack.content as ContentPackContent | undefined;

    const bpPaths = new Set((bp?.sitemap ?? []).map((p) => p.path));
    const cpPages = cp?.pages ?? [];

    for (const page of cpPages) {
      // Content field mapped to a page that doesn't exist in the blueprint
      if (!bpPaths.has(page.path)) {
        conflicts.push({
          kind: "content_field_unresolvable",
          detail: `Content pack page "${page.path}" is not in the site blueprint sitemap.`,
          artifactIds: [contentPack.id, blueprint.id],
        });
        continue;
      }
      pages.push({
        path: page.path,
        title: page.title,
        templateType: "page",
        sectionRequirements: page.sections ?? [],
        contentMappings: {
          h1: page.h1,
          meta_title: page.title,
          meta_description: page.metaDescription,
        },
        responsiveRequirements: ["Mobile-first", "Tablet breakpoint at 768px", "Desktop at 1024px+"],
        seoMeta: { title: page.title, metaDescription: page.metaDescription, h1: page.h1 },
        assetRefs: [],
      });
    }

    // Blueprint sections without matching content
    for (const bpPage of bp?.sitemap ?? []) {
      const hasContent = cpPages.some((p) => p.path === bpPage.path);
      if (!hasContent) {
        conflicts.push({
          kind: "section_missing_from_blueprint",
          detail: `Blueprint page "${bpPage.path}" (${bpPage.title}) has no content pack entry.`,
          artifactIds: [blueprint.id, contentPack.id],
        });
      }
    }
  }

  const packId = newId("bp");
  const buildPack: BuildPack = {
    id: packId,
    projectId,
    version: 1,
    status: conflicts.length > 0 ? "CONFLICT" : "READY",
    siteBlueprintArtifactId: blueprint?.id ?? null,
    designSystemArtifactId: designSystem?.id ?? null,
    contentPackArtifactId: contentPack?.id ?? null,
    pages,
    constraints: ["No custom JS without QA approval", "Elementor native widgets preferred"],
    permissions: opts.permissions ?? ["GREEN"],
    acceptanceCriteria: [
      "All pages render correctly at mobile/tablet/desktop",
      "No placeholder text or images",
      "QA pass before handoff",
    ],
    evidenceRequirements: ["Screenshot of each page at 375px and 1440px viewport after build"],
    conflicts,
    assembledByJobId: opts.jobId ?? null,
    assembledAt: at,
    supersededById: null,
    createdAt: at,
  };

  return {
    data: { ...data, buildPacks: [...data.buildPacks, buildPack] },
    buildPack,
  };
}

/** Supersede an existing build pack (e.g. after resolving conflicts and re-assembling). */
export function supersedeBuildPack(data: OSData, oldPackId: string, newPackId: string): OSData {
  return {
    ...data,
    buildPacks: data.buildPacks.map((bp) =>
      bp.id === oldPackId ? { ...bp, status: "SUPERSEDED", supersededById: newPackId } : bp,
    ),
  };
}

/** Find the current READY or ASSEMBLING pack for a project. */
export function currentBuildPack(data: OSData, projectId: string): BuildPack | null {
  return (
    data.buildPacks
      .filter((bp) => bp.projectId === projectId && (bp.status === "READY" || bp.status === "ASSEMBLING"))
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

/**
 * Guard: a job pack must only reference artifacts belonging to its own project.
 * Returns true when the pack is safe; false when a cross-project reference is detected.
 */
export function buildPackIsolationCheck(data: OSData, pack: BuildPack): BuildPackConflict[] {
  return crossProjectCheck(
    pack.projectId,
    [pack.siteBlueprintArtifactId, pack.designSystemArtifactId, pack.contentPackArtifactId],
    data,
  );
}

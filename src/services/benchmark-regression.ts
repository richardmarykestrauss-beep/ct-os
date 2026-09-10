/**
 * Benchmark regression harness (CTOS-005A Part 30).
 *
 * Runs deterministic regression checks against frozen fixture files.
 * NEVER modifies the frozen fixtures.
 * NEVER makes live API calls — uses StubProvider or replayed fixture responses.
 *
 * "frozen" means the fixture file content at the time of the last green benchmark run.
 * Any deviation in schema shape, field presence, or value type from the frozen state
 * is a regression.
 */
import type { OSData } from "@/data/types";
import { SCHEMAS } from "@/schemas/artifacts";

type SchemaMap = typeof SCHEMAS;
const schemasAsMap = SCHEMAS as Record<string, SchemaMap[keyof SchemaMap] | undefined>;

// ---------------------------------------------------------------------------
// Fixture types (frozen benchmark artifacts are JSON files, never mutated)
// ---------------------------------------------------------------------------

export interface FrozenFixture {
  /** Path relative to the benchmark fixture directory */
  path: string;
  /** Zod schema key ("type@version") that this fixture must satisfy */
  schemaKey: string;
  /** Human-readable description of what this fixture represents */
  description: string;
  content: unknown;
}

export interface RegressionResult {
  fixture: string;
  schemaKey: string;
  passed: boolean;
  issues: string[];
}

export interface RegressionReport {
  runAt: string;
  totalFixtures: number;
  passed: number;
  failed: number;
  results: RegressionResult[];
}

// ---------------------------------------------------------------------------
// Core regression runner
// ---------------------------------------------------------------------------

/**
 * Validate every fixture against its declared schema.
 * Returns a complete report — never throws.
 * Does not read from disk; callers supply pre-loaded fixtures.
 */
export function runRegressionSuite(fixtures: FrozenFixture[]): RegressionReport {
  const results: RegressionResult[] = [];

  for (const fixture of fixtures) {
    const schema = schemasAsMap[fixture.schemaKey];
    if (!schema) {
      results.push({
        fixture: fixture.path,
        schemaKey: fixture.schemaKey,
        passed: false,
        issues: [`Schema "${fixture.schemaKey}" not found in SCHEMAS registry`],
      });
      continue;
    }

    const parsed = schema.safeParse(fixture.content);
    if (parsed.success) {
      results.push({ fixture: fixture.path, schemaKey: fixture.schemaKey, passed: true, issues: [] });
    } else {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      results.push({ fixture: fixture.path, schemaKey: fixture.schemaKey, passed: false, issues });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    runAt: new Date().toISOString(),
    totalFixtures: fixtures.length,
    passed,
    failed: fixtures.length - passed,
    results,
  };
}

// ---------------------------------------------------------------------------
// Project isolation check
// ---------------------------------------------------------------------------

/**
 * Verify that OSData artifacts from project A cannot appear in project B's artifact arrays.
 * This is a data-layer regression test — it should be impossible in normal use,
 * but the harness proves it explicitly (Part 23).
 */
export function assertProjectIsolation(
  data: OSData,
  projectAId: string,
  projectBId: string,
): { isolated: boolean; violations: string[] } {
  const violations: string[] = [];

  const bArtifacts = data.artifacts.filter((a) => a.projectId === projectBId);
  const aIds = new Set(data.artifacts.filter((a) => a.projectId === projectAId).map((a) => a.id));

  for (const art of bArtifacts) {
    if (aIds.has(art.id)) {
      violations.push(`Artifact ${art.id} (type: ${art.type}) appears in both project A (${projectAId}) and project B (${projectBId})`);
    }
  }

  const bJobs = data.agentJobs.filter((j) => j.projectId === projectBId);
  for (const job of bJobs) {
    for (const inputId of job.inputArtifactIds ?? []) {
      const art = data.artifacts.find((a) => a.id === inputId);
      if (art && art.projectId === projectAId) {
        violations.push(`Job ${job.id} in project B (${projectBId}) references artifact ${inputId} from project A (${projectAId})`);
      }
    }
  }

  const bBuildPacks = data.buildPacks.filter((bp) => bp.projectId === projectBId);
  for (const bp of bBuildPacks) {
    for (const refId of [bp.siteBlueprintArtifactId, bp.designSystemArtifactId, bp.contentPackArtifactId]) {
      if (!refId) continue;
      const art = data.artifacts.find((a) => a.id === refId);
      if (art && art.projectId === projectAId) {
        violations.push(`BuildPack ${bp.id} in project B (${projectBId}) references artifact ${refId} from project A (${projectAId})`);
      }
    }
  }

  return { isolated: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Visual context isolation (CTOS-005B Part 30)
// ---------------------------------------------------------------------------

/**
 * Verify that CTOS-005B visual context from project A cannot appear in project B's
 * visual data arrays. This is a deterministic fixture-level regression test — it proves
 * the isolation contract without running a live benchmark.
 *
 * Checks:
 *   - Visual references (PROJECT-scoped, have projectId)
 *   - Signature visual elements (PROJECT-scoped)
 *   - Design token sets (PROJECT-scoped)
 *   - Visual defects (PROJECT-scoped)
 *   - Design↔content reconciliations (PROJECT-scoped)
 *   - Screenshot evidence (PROJECT-scoped)
 *   - Agent lessons (PROJECT-scoped when not DOCTRINE/AGENCY)
 *   - Artifacts: design_direction, page_composition, visual_review, elementor_build_manifest
 *
 * DOCTRINE- and AGENCY-scoped knowledge remains shared (allowed by governance).
 * Fails closed: any cross-project reference is a violation.
 */
export function assertVisualContextIsolation(
  data: OSData,
  projectAId: string,
  projectBId: string,
): { isolated: boolean; violations: string[] } {
  const violations: string[] = [];

  const aId = projectAId;
  const bId = projectBId;

  // Visual references
  const aVisualRefIds = new Set(data.visualReferences.filter((r) => r.projectId === aId).map((r) => r.id));
  for (const r of data.visualReferences.filter((r) => r.projectId === bId)) {
    if (aVisualRefIds.has(r.id)) {
      violations.push(`VisualReference ${r.id} appears in both project A (${aId}) and project B (${bId})`);
    }
  }

  // Signature visual elements
  const aSigIds = new Set(data.signatureVisualElements.filter((e) => e.projectId === aId).map((e) => e.id));
  for (const e of data.signatureVisualElements.filter((e) => e.projectId === bId)) {
    if (aSigIds.has(e.id)) {
      violations.push(`SignatureVisualElement ${e.id} appears in both project A (${aId}) and project B (${bId})`);
    }
  }

  // Design token sets
  const aTokenIds = new Set(data.designTokenSets.filter((t) => t.projectId === aId).map((t) => t.id));
  for (const t of data.designTokenSets.filter((t) => t.projectId === bId)) {
    if (aTokenIds.has(t.id)) {
      violations.push(`DesignTokenSet ${t.id} appears in both project A (${aId}) and project B (${bId})`);
    }
  }

  // Visual defects
  const aDefectIds = new Set(data.visualDefects.filter((d) => d.projectId === aId).map((d) => d.id));
  for (const d of data.visualDefects.filter((d) => d.projectId === bId)) {
    if (aDefectIds.has(d.id)) {
      violations.push(`VisualDefect ${d.id} appears in both project A (${aId}) and project B (${bId})`);
    }
  }

  // Design↔content reconciliations
  const aRecIds = new Set(data.designContentReconciliations.filter((r) => r.projectId === aId).map((r) => r.id));
  for (const r of data.designContentReconciliations.filter((r) => r.projectId === bId)) {
    if (aRecIds.has(r.id)) {
      violations.push(`DesignContentReconciliation ${r.id} appears in both project A (${aId}) and project B (${bId})`);
    }
  }

  // Screenshot evidence — project B must not reference project A's captured screenshots
  const aShotIds = new Set(data.screenshotEvidence.filter((s) => s.projectId === aId).map((s) => s.id));
  for (const s of data.screenshotEvidence.filter((s) => s.projectId === bId)) {
    if (aShotIds.has(s.id)) {
      violations.push(`ScreenshotEvidence ${s.id} appears in both project A (${aId}) and project B (${bId})`);
    }
  }

  // Visual artifacts — design_direction, page_composition, visual_review, elementor_build_manifest
  const visualArtifactTypes = new Set(["design_direction", "page_composition", "visual_review", "elementor_build_manifest"]);
  const aVisualArtIds = new Set(
    data.artifacts.filter((a) => a.projectId === aId && visualArtifactTypes.has(a.type)).map((a) => a.id),
  );
  for (const a of data.artifacts.filter((a) => a.projectId === bId && visualArtifactTypes.has(a.type))) {
    if (aVisualArtIds.has(a.id)) {
      violations.push(`Visual artifact ${a.id} (type: ${a.type}) appears in both project A (${aId}) and project B (${bId})`);
    }
  }

  // Jobs: project B visual jobs must not reference project A's visual artifacts as inputs
  const bVisualJobs = data.agentJobs.filter(
    (j) => j.projectId === bId && (j.taskType === "visual_review" || j.taskType === "creative_direction"),
  );
  for (const job of bVisualJobs) {
    for (const inputId of job.inputArtifactIds) {
      const art = data.artifacts.find((a) => a.id === inputId);
      if (art && art.projectId === aId) {
        violations.push(
          `Visual job ${job.id} in project B (${bId}) references artifact ${inputId} (type: ${art.type}) from project A (${aId})`,
        );
      }
    }
  }

  // Agent lessons — PROJECT-scoped lessons must not cross projects
  // DOCTRINE and AGENCY are intentionally shared (no violation)
  const aLessonIds = new Set(
    data.agentLessons.filter((l) => l.projectId === aId).map((l) => l.id),
  );
  for (const lesson of data.agentLessons.filter((l) => l.projectId === bId)) {
    if (aLessonIds.has(lesson.id)) {
      violations.push(`AgentLesson ${lesson.id} appears in both project A (${aId}) and project B (${bId})`);
    }
  }

  return { isolated: violations.length === 0, violations };
}

/** Verify that all required CTOS-005A+005B schemas are registered in the SCHEMAS map. */
export function assertRequiredSchemas005B(): { ok: boolean; missing: string[] } {
  const required = ["design_direction@1", "page_composition@1", "visual_review@1", "elementor_build_manifest@1"];
  const missing = required.filter((k) => !schemasAsMap[k]);
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Schema presence check
// ---------------------------------------------------------------------------

/** Verify that all required CTOS-005A schemas are registered in the SCHEMAS map. */
export function assertRequiredSchemas(): { ok: boolean; missing: string[] } {
  const required = ["build_pack@1", "job_pack@1"];
  const missing = required.filter((k) => !schemasAsMap[k]);
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Determinism check
// ---------------------------------------------------------------------------

/**
 * Run the same fixture through the schema validator twice and confirm identical output.
 * Validates that the schema has no random or stateful side effects.
 */
export function assertValidationDeterminism(schemaKey: string, fixture: unknown): boolean {
  const schema = schemasAsMap[schemaKey];
  if (!schema) return false;
  const r1 = schema.safeParse(fixture);
  const r2 = schema.safeParse(fixture);
  return r1.success === r2.success && JSON.stringify(r1) === JSON.stringify(r2);
}

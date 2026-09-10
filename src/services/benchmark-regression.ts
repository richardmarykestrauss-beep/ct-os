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

/**
 * CTOS-008: every table SupabaseRepository.load() queries must actually exist in a migration.
 *
 * SupabaseRepository.load() does `select("*")` against every entry in TABLES (mapping.ts) and
 * throws on the first missing table — so a table present in the app's mapping but absent from
 * supabase/migrations/*.sql makes Supabase persistence mode unusable the moment that OSData
 * collection is non-empty. FakeSupabaseClient-backed tests (repository.test.ts) can't catch this:
 * a fake has no real schema to be missing from. This test reads the actual migration SQL.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TABLES } from "@/services/supabase/mapping";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");

function migratedTableNames(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const m of sql.matchAll(/create table if not exists\s+([a-z_][a-z0-9_]*)/gi)) names.add(m[1].toLowerCase());
  }
  return names;
}

describe("Supabase migration coverage", () => {
  it("every table in mapping.ts TABLES is created by a migration", () => {
    const migrated = migratedTableNames();
    const missing = TABLES.map((t) => t.table).filter((t) => !migrated.has(t));
    expect(missing, `tables referenced by SupabaseRepository but missing from supabase/migrations/*.sql: ${missing.join(", ")}`).toEqual([]);
  });

  it("no migration defines a table that mapping.ts does not know about (orphaned schema)", () => {
    // Identity tables (0002_identity_gateway.sql): consulted by the gateway/RLS via auth.uid(), not
    // part of OSData — they intentionally have no TableSpec.
    const IDENTITY_TABLES = new Set(["profiles", "invites"]);
    const mapped = new Set<string>(TABLES.map((t) => t.table));
    const orphaned = [...migratedTableNames()].filter((t) => !mapped.has(t) && !IDENTITY_TABLES.has(t));
    expect(orphaned, `tables created in migrations but never read/written by the app: ${orphaned.join(", ")}`).toEqual([]);
  });
});

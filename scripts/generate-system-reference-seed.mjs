/**
 * Generates supabase/migrations/0005_system_reference_seed.sql from the SAME canonical source the
 * app itself uses at runtime — src/data/seed.ts's `productionBootstrapData` — via the SAME
 * serializer the repository uses (src/services/supabase/mapping.ts's toRow()). Nothing here is
 * hand-transcribed: every column value in the generated SQL is exactly what toRow() would send to
 * Supabase for that row, so the migration and the CTOS-008H runtime self-heal can never drift.
 *
 * Run: node scripts/generate-system-reference-seed.mjs
 * (Regenerate and re-run whenever the canonical agent/gate/skill/integration/section-library/
 * doctrine definitions in data/seed.ts change — do not hand-edit the generated migration.)
 */
import { buildSync } from "esbuild";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const bundled = buildSync({
  stdin: {
    contents: `
      export { productionBootstrapData } from "@/data/seed";
      export { TABLES, toRow } from "@/services/supabase/mapping";
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "cjs",
  platform: "node",
  packages: "external",
  alias: { "@": path.resolve("src") },
  write: false,
});
const mod = { exports: {} };
new Function("module", "exports", "require", bundled.outputFiles[0].text)(mod, mod.exports, require);
const { productionBootstrapData, TABLES, toRow } = mod.exports;

// Column type per system-reference table — determines SQL literal formatting. Matches the exact
// column types in supabase/migrations/0001, 0003 and 0004 (re-verified against those files, not
// guessed) — see this script's sibling migration file for the authoritative column list per table.
const COLUMN_TYPES = {
  agents: {
    id: "text", code: "text", short_code: "text", name: "text", role: "text", responsibilities: "jsonb",
    status: "text", status_detail: "text", current_project_id: "text", current_ticket_id: "text",
    last_run_at: "timestamptz", outputs_produced: "int", provider_policy: "jsonb", permission_level: "text",
    required_capabilities: "jsonb", produces_artifact_types: "jsonb", consumes_artifact_types: "jsonb",
    can_execute_site_changes: "bool", created_at: "timestamptz", updated_at: "timestamptz",
    mission: "text", exclusions: "jsonb", default_priority: "text", instruction_pack_ids: "jsonb",
  },
  gates: {
    id: "text", key: "text", label: "text", order: "int", requires_human_approval: "bool",
    required_artifact_types: "jsonb", confirm_on_open_holds: "bool", description: "text",
  },
  skills: {
    id: "text", name: "text", version: "int", kind: "text", status: "text", scope: "text",
    owner_agent_ids: "jsonb", reviewer_agent_ids: "jsonb", content: "text", evidence: "jsonb",
    supersedes_id: "text", approved_by: "text", approved_by_id: "uuid", approved_at: "timestamptz",
    created_at: "timestamptz", updated_at: "timestamptz",
  },
  integrations: {
    id: "text", name: "text", plane: "text", purpose: "text", status: "text", provider_id: "text",
    created_at: "timestamptz", updated_at: "timestamptz",
  },
  section_library: {
    id: "text", name: "jsonb", description: "jsonb", category: "jsonb", status: "jsonb",
    build_strategy: "jsonb", novelty_justification: "jsonb", evidence: "jsonb", approved_by: "jsonb",
    approved_at: "timestamptz", created_at: "timestamptz",
  },
  knowledge_items: {
    id: "text", scope: "text", category: "text", title: "text", content: "text", evidence: "jsonb",
    confidence: "numeric", status: "text", project_id: "text", job_id: "text",
    proposed_by_agent_id: "text", reviewed_by: "text", reviewed_at: "timestamptz",
    created_at: "timestamptz", updated_at: "timestamptz",
  },
};

// Columns the live schema declares NOT NULL (supabase/migrations/0001, 0003) — cross-checked
// against the actual .sql files, not inferred from TypeScript types, because toRow() silently
// turns a TS-optional (undefined) field into an explicit NULL (see mapping.ts), which the DB
// then rejects for any of these. CTOS-008K: this generator used to trust TS optionality alone and
// shipped a migration where agents.exclusions/instruction_pack_ids were NULL for several agents.
const NOT_NULL_COLUMNS = {
  agents: [
    "code", "short_code", "name", "role", "responsibilities", "status", "outputs_produced",
    "provider_policy", "permission_level", "required_capabilities", "produces_artifact_types",
    "consumes_artifact_types", "can_execute_site_changes", "exclusions", "instruction_pack_ids",
  ],
  gates: ["key", "label", "order", "requires_human_approval", "required_artifact_types", "confirm_on_open_holds", "description"],
  skills: ["name", "version", "kind", "status", "scope", "owner_agent_ids", "reviewer_agent_ids", "content", "evidence"],
  integrations: ["name", "plane", "purpose", "status"],
  section_library: [], // every column but id is nullable (no NOT NULL in 0004)
  knowledge_items: ["scope", "category", "title", "content", "evidence", "confidence", "status"],
};

// uuid-typed columns: a non-null value that isn't a real UUID fails the insert with a cast error
// (this is exactly how the "u_admin_seed" placeholder broke skills in CTOS-008J).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Columns that must be null in an install-time system-reference seed because the tables they'd
// reference (projects, tickets) are never seeded here — any non-null value is a dangling FK
// pointing at demo/project data that doesn't exist yet (this is exactly how ORCH's
// current_project_id="proj_uproof" broke the entire agents insert in CTOS-008J).
const MUST_BE_NULL_COLUMNS = {
  agents: ["current_project_id", "current_ticket_id"],
};

function validateRow(table, row, errors) {
  for (const col of NOT_NULL_COLUMNS[table] ?? []) {
    if (row[col] === null || row[col] === undefined) errors.push(`${table}.${row.id ?? "?"}: column "${col}" is NOT NULL but got ${row[col]}`);
  }
  for (const col of MUST_BE_NULL_COLUMNS[table] ?? []) {
    if (row[col] !== null && row[col] !== undefined) errors.push(`${table}.${row.id ?? "?"}: column "${col}" must be null in a system-reference seed (dangling reference to "${row[col]}")`);
  }
  for (const [col, type] of Object.entries(COLUMN_TYPES[table] ?? {})) {
    if (type === "uuid" && row[col] != null && !UUID_RE.test(String(row[col]))) {
      errors.push(`${table}.${row.id ?? "?"}: column "${col}" is uuid-typed but got non-UUID value "${row[col]}"`);
    }
  }
}

function sqlLiteral(value, type) {
  if (value === null || value === undefined) return "NULL";
  switch (type) {
    case "bool":
      return value ? "true" : "false";
    case "int":
    case "numeric":
      return String(Number(value));
    case "jsonb":
      return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
    case "timestamptz":
    case "uuid":
    case "text":
    default:
      return `'${String(value).replace(/'/g, "''")}'`;
  }
}

function insertStatement(table, columnTypes, row) {
  const cols = Object.keys(columnTypes);
  const values = cols.map((c) => sqlLiteral(row[c], columnTypes[c]));
  const quotedCols = cols.map((c) => (c === "order" ? `"order"` : c));
  return `insert into ${table} (${quotedCols.join(", ")}) values (${values.join(", ")}) on conflict (id) do nothing;`;
}

const SYSTEM_REFERENCE = [
  { key: "agents", table: "agents" },
  { key: "gates", table: "gates" },
  { key: "skills", table: "skills" },
  { key: "integrations", table: "integrations" },
  { key: "sectionLibrary", table: "section_library" },
];

const specByTable = new Map(TABLES.map((s) => [s.table, s]));
const errors = [];
const sections = [];
for (const { key, table } of SYSTEM_REFERENCE) {
  const spec = specByTable.get(table);
  const rows = productionBootstrapData[key].map((entity) => toRow(entity));
  for (const row of rows) validateRow(table, row, errors);
  const stmts = rows.map((row) => insertStatement(table, COLUMN_TYPES[table], row));
  sections.push(`-- ---------------------------------------------------------------- ${table} (${rows.length} row${rows.length === 1 ? "" : "s"})\n${stmts.join("\n")}`);
}
// DOCTRINE-only knowledge — same table as PROJECT/TASK-scope items (never inserted here), filtered by scope.
const doctrineSpec = specByTable.get("knowledge_items");
void doctrineSpec;
const doctrineRows = productionBootstrapData.knowledgeItems.filter((k) => k.scope === "DOCTRINE").map((entity) => toRow(entity));
for (const row of doctrineRows) validateRow("knowledge_items", row, errors);
sections.push(`-- ---------------------------------------------------------------- knowledge_items (DOCTRINE only, ${doctrineRows.length} row${doctrineRows.length === 1 ? "" : "s"})\n${doctrineRows.map((row) => insertStatement("knowledge_items", COLUMN_TYPES.knowledge_items, row)).join("\n")}`);

if (errors.length) {
  console.error(`Refusing to generate 0005_system_reference_seed.sql — ${errors.length} row(s) would violate real Postgres constraints:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const header = `-- Creative Touch Website OS — CTOS-008J: explicit system reference seed
--
-- Installation-level data only: the canonical agent roster (ORCH + A01-A08), workflow gates,
-- skills/instruction packs, the integrations catalogue, the reusable section library, and
-- DOCTRINE-scope knowledge. Generated verbatim from src/data/seed.ts's \`productionBootstrapData\`
-- via scripts/generate-system-reference-seed.mjs — do not hand-edit; regenerate instead if the
-- canonical definitions in seed.ts change. Every value here is exactly what the app's own runtime
-- self-heal (CTOS-008H, SupabaseRepository.load()) would write using the same toRow() serializer —
-- this migration makes that install-time state explicit and idempotent rather than relying only on
-- a self-heal that runs on first authenticated load.
--
-- NEVER inserts: clients, projects, tickets, artifacts, QA, approvals, launch holds, activity,
-- AGENCY-scope knowledge, or any project/client-instance data. Nothing here touches those tables.
--
-- Idempotent: every statement is "insert ... on conflict (id) do nothing" — running this migration
-- any number of times, against a database that already has some or all of these rows (including
-- rows an operator has since edited), never duplicates a row and never overwrites an existing one.
-- No DELETE, no TRUNCATE, no UPDATE.

`;

writeFileSync("supabase/migrations/0005_system_reference_seed.sql", header + sections.join("\n\n") + "\n");
console.log("Wrote supabase/migrations/0005_system_reference_seed.sql");

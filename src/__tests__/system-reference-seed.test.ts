/**
 * CTOS-008J: static checks on the generated system-reference migration
 * (supabase/migrations/0005_system_reference_seed.sql) and the productionBootstrapData it's
 * generated from. These are the checks FakeSupabaseClient-based tests structurally cannot make —
 * it enforces neither foreign keys nor column types, which is exactly how the two dangling
 * references fixed in this ticket (ORCH's current_project_id, one skill's approved_by_id) went
 * undetected until a real SQL migration was generated from the same data.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS, productionBootstrapData } from "@/data/seed";
import { TABLES } from "@/services/supabase/mapping";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION_PATH = join(MIGRATIONS_DIR, "0005_system_reference_seed.sql");
const sql = readFileSync(MIGRATION_PATH, "utf8");
// Statements only — the header's own prose ("no DELETE, no TRUNCATE...") would otherwise false-positive.
const statementsOnly = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

/**
 * CTOS-008K: parse the REAL `create table`/`alter table ... add column` statements for `agents`
 * out of 0001_ctos_core.sql and 0003_intelligence_model.sql to get the actual set of NOT NULL
 * columns Postgres enforces — not a hand-maintained list that can drift from the schema (which is
 * exactly how CTOS-008J's migration shipped `exclusions`/`instruction_pack_ids` as NULL: nothing
 * checked the generated SQL against the schema those columns actually live in).
 */
function notNullColumnsFor(table: string): Set<string> {
  const combined = ["0001_ctos_core.sql", "0003_intelligence_model.sql"].map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8")).join("\n");
  const columns = new Set<string>();
  const createMatch = combined.match(new RegExp(`create table if not exists ${table} \\(([\\s\\S]*?)\\n\\);`));
  if (createMatch) {
    for (const line of createMatch[1].split("\n")) {
      const m = line.match(/^\s*(\w+)\s+[\w()]+(?:\s+not null)/);
      if (m && /not null/.test(line)) columns.add(m[1]);
    }
  }
  const alterRe = new RegExp(`alter table ${table} add column if not exists (\\w+)\\s+[\\w()]+\\s+not null`, "g");
  for (const m of combined.matchAll(alterRe)) columns.add(m[1]);
  return columns;
}

describe("0005_system_reference_seed.sql", () => {
  it("inserts all 9 canonical agent ids", () => {
    for (const id of Object.values(AGENT_IDS)) {
      expect(sql, `missing insert for ${id}`).toMatch(new RegExp(`insert into agents \\(.*\\) values \\('${id}'`));
    }
    expect(Object.values(AGENT_IDS)).toHaveLength(9);
  });

  it("contains no demo client/project/ticket ids (proj_uproof, U-Proof tickets, or any CT-UP-* code)", () => {
    expect(sql).not.toMatch(/proj_uproof/);
    expect(sql).not.toMatch(/ct-up-/i);
    expect(sql).not.toMatch(/client_uproof|c_uproof/);
  });

  it("contains no other dangling references into fixture-only data (fake admin id, demo approval/hold ids)", () => {
    expect(sql).not.toMatch(/u_admin_seed/);
    expect(sql).not.toMatch(/appr_up|hold_up|qarun_up|art_up|kn_up_/);
  });

  it("is idempotent: every statement is INSERT ... ON CONFLICT (id) DO NOTHING, never UPDATE/DELETE/TRUNCATE", () => {
    const statements = sql.split("\n").filter((l) => l.trim().startsWith("insert into"));
    expect(statements.length).toBeGreaterThan(20); // 9 agents + 4 gates + 3 skills + 11 integrations + 15 sections + 4 doctrine
    for (const stmt of statements) expect(stmt, stmt).toMatch(/on conflict \(id\) do nothing;\s*$/);
    expect(statementsOnly).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    expect(statementsOnly).not.toMatch(/\bdelete\s+from\b/i);
    expect(statementsOnly).not.toMatch(/^\s*truncate\b/im);
  });

  it("only targets tables that are genuinely system-reference (per mapping.ts) — never a project/client/audit table", () => {
    const targeted = new Set([...sql.matchAll(/insert into (\w+)/g)].map((m) => m[1]));
    expect(targeted).toEqual(new Set(["agents", "gates", "skills", "integrations", "section_library", "knowledge_items"]));
    for (const table of targeted) expect(TABLES.some((t) => t.table === table), `${table} not in mapping.ts TABLES`).toBe(true);
  });

  it("CTOS-008K: never inserts NULL into a column the live schema (0001/0003) declares NOT NULL", () => {
    const notNull = notNullColumnsFor("agents");
    expect(notNull.has("exclusions"), "sanity: schema parser found agents.exclusions NOT NULL").toBe(true);
    expect(notNull.has("instruction_pack_ids"), "sanity: schema parser found agents.instruction_pack_ids NOT NULL").toBe(true);

    const agentInserts = [...sql.matchAll(/insert into agents \(([^)]+)\) values \(([\s\S]*?)\) on conflict/g)];
    expect(agentInserts.length).toBe(9);
    for (const [, colList, valuesRaw] of agentInserts) {
      const cols = colList.split(",").map((c) => c.trim());
      // Split top-level commas only — values themselves may contain commas inside '...'::jsonb blobs.
      const values: string[] = [];
      let depth = 0;
      let cur = "";
      for (const ch of valuesRaw) {
        if (ch === "'") depth = depth ? 0 : 1; // crude but sufficient: no escaped quotes span a comma boundary here
        if (ch === "," && depth === 0) {
          values.push(cur.trim());
          cur = "";
        } else {
          cur += ch;
        }
      }
      values.push(cur.trim());
      expect(values.length, `column/value count mismatch: ${cols.length} cols vs ${values.length} values`).toBe(cols.length);
      for (const col of notNull) {
        const idx = cols.indexOf(col);
        if (idx === -1) continue;
        expect(values[idx], `agents.${col} must not be NULL`).not.toBe("NULL");
      }
    }
  });
});

describe("productionBootstrapData: no dangling references into demo-only data (regression)", () => {
  it("no agent references a project/ticket that doesn't exist in a clean install", () => {
    for (const agent of productionBootstrapData.agents) {
      expect(agent.currentProjectId, `${agent.id}.currentProjectId`).toBeNull();
      expect(agent.currentTicketId, `${agent.id}.currentTicketId`).toBeNull();
    }
  });

  it("no skill's approved_by_id is a non-UUID fixture placeholder", () => {
    for (const skill of productionBootstrapData.skills) {
      expect(skill.approvedById, `${skill.id}.approvedById`).toBeNull();
    }
  });

  it("no DOCTRINE knowledge item cites a demo-only record id as evidence", () => {
    for (const item of productionBootstrapData.knowledgeItems) {
      for (const ref of item.evidence) expect(ref, `${item.id} evidence`).not.toMatch(/^(appr_up|hold_up|qarun_up|art_up|kn_up_|proj_uproof)/);
    }
  });

  it("CTOS-008K: every agent's exclusions and instructionPackIds are real arrays, never undefined (NOT NULL jsonb columns)", () => {
    for (const a of productionBootstrapData.agents) {
      expect(Array.isArray(a.exclusions), `${a.id}.exclusions`).toBe(true);
      expect(Array.isArray(a.instructionPackIds), `${a.id}.instructionPackIds`).toBe(true);
    }
  });
});

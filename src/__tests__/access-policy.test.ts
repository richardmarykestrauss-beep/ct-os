/**
 * Pure mirror of the per-table RLS delete/insert/update split (supabase/migrations/
 * 0002_identity_gateway.sql). See src/services/access-policy.ts for why this exists — there is no
 * local Postgres harness in this environment to test the actual policies against, so this is the
 * automated regression for the rule the SQL implements; kept in sync by code review + the comments
 * cross-referencing each other in both files.
 */
import { describe, expect, it } from "vitest";
import { ADMIN_ONLY_DELETE_TABLES, ALL_POLICY_TABLES, canMutate, canRead, LEAD_DELETE_TABLES, type PolicyTable } from "@/services/access-policy";
import type { UserRole } from "@/data/types";

const ROLES: UserRole[] = ["ADMIN", "PRODUCTION_LEAD", "TEAM_MEMBER", "VIEWER"];

describe("canRead", () => {
  it("is gated purely on activation — role never matters for read", () => {
    expect(canRead(true)).toBe(true);
    expect(canRead(false)).toBe(false);
  });
});

describe("canMutate — activation gate", () => {
  it("an inactive account can do nothing, regardless of role or table", () => {
    for (const role of ROLES) {
      for (const table of ALL_POLICY_TABLES) {
        expect(canMutate(role, false, table, "insert")).toBe(false);
        expect(canMutate(role, false, table, "update")).toBe(false);
        expect(canMutate(role, false, table, "delete")).toBe(false);
      }
    }
  });
});

describe("canMutate — VIEWER is read-only, always", () => {
  it("VIEWER cannot insert, update or delete on any table, even active", () => {
    for (const table of ALL_POLICY_TABLES) {
      expect(canMutate("VIEWER", true, table, "insert")).toBe(false);
      expect(canMutate("VIEWER", true, table, "update")).toBe(false);
      expect(canMutate("VIEWER", true, table, "delete")).toBe(false);
    }
  });
});

describe("canMutate — insert/update: any active non-VIEWER", () => {
  it("ADMIN, PRODUCTION_LEAD and TEAM_MEMBER can all insert and update every table when active", () => {
    for (const role of ["ADMIN", "PRODUCTION_LEAD", "TEAM_MEMBER"] as UserRole[]) {
      for (const table of ALL_POLICY_TABLES) {
        expect(canMutate(role, true, table, "insert")).toBe(true);
        expect(canMutate(role, true, table, "update")).toBe(true);
      }
    }
  });
});

describe("canMutate — delete: TEAM_MEMBER never, on anything", () => {
  it("TEAM_MEMBER cannot delete any policy table, admin-only or lead-eligible", () => {
    for (const table of ALL_POLICY_TABLES) {
      expect(canMutate("TEAM_MEMBER", true, table, "delete")).toBe(false);
    }
  });
});

describe("canMutate — delete: ADMIN-only tables", () => {
  it("ADMIN can delete; PRODUCTION_LEAD cannot", () => {
    for (const table of ADMIN_ONLY_DELETE_TABLES as readonly PolicyTable[]) {
      expect(canMutate("ADMIN", true, table, "delete")).toBe(true);
      expect(canMutate("PRODUCTION_LEAD", true, table, "delete")).toBe(false);
    }
  });
});

describe("canMutate — routine operational tables allow PRODUCTION_LEAD delete too", () => {
  it("both ADMIN and PRODUCTION_LEAD can delete", () => {
    for (const table of LEAD_DELETE_TABLES as readonly PolicyTable[]) {
      expect(canMutate("ADMIN", true, table, "delete")).toBe(true);
      expect(canMutate("PRODUCTION_LEAD", true, table, "delete")).toBe(true);
    }
  });
});

describe("canMutate — specific audit-sensitive tables named in the ticket", () => {
  it.each(["projects", "clients", "artifacts", "agent_runs", "activity_events", "approvals", "knowledge_items", "agent_lessons", "launch_holds", "qa_runs", "execution_logs"] as const)(
    "%s: TEAM_MEMBER and PRODUCTION_LEAD cannot delete; only ADMIN can",
    (table) => {
      expect(canMutate("TEAM_MEMBER", true, table, "delete")).toBe(false);
      expect(canMutate("PRODUCTION_LEAD", true, table, "delete")).toBe(false);
      expect(canMutate("ADMIN", true, table, "delete")).toBe(true);
    },
  );
});

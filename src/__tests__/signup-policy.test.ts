/**
 * Pure mirror of the sign-up trigger (supabase/migrations/0002_identity_gateway.sql
 * ctos_handle_new_user). See src/services/signup-policy.ts for why this exists.
 */
import { describe, expect, it } from "vitest";
import { resolveSignup, type InviteRecord } from "@/services/signup-policy";

const NOW = "2026-01-01T00:00:00.000Z";

describe("resolveSignup", () => {
  it("assigns the invited role and activates when a live invite matches the email", () => {
    const invites: InviteRecord[] = [{ email: "new@ct.test", role: "PRODUCTION_LEAD", usedAt: null, expiresAt: null }];
    expect(resolveSignup("new@ct.test", invites, NOW)).toEqual({ role: "PRODUCTION_LEAD", active: true, matchedInvite: true });
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    const invites: InviteRecord[] = [{ email: "  New@CT.test  ", role: "ADMIN", usedAt: null, expiresAt: null }];
    expect(resolveSignup("new@ct.test", invites, NOW)).toEqual({ role: "ADMIN", active: true, matchedInvite: true });
  });

  it("registration order never grants ADMIN — no invite means an inert VIEWER, every time", () => {
    expect(resolveSignup("first-ever-user@ct.test", [], NOW)).toEqual({ role: "VIEWER", active: false, matchedInvite: false });
    expect(resolveSignup("second-user@ct.test", [], NOW)).toEqual({ role: "VIEWER", active: false, matchedInvite: false });
  });

  it("a used invite never matches again", () => {
    const invites: InviteRecord[] = [{ email: "again@ct.test", role: "ADMIN", usedAt: "2025-12-01T00:00:00.000Z", expiresAt: null }];
    expect(resolveSignup("again@ct.test", invites, NOW)).toEqual({ role: "VIEWER", active: false, matchedInvite: false });
  });

  it("an expired invite never matches", () => {
    const invites: InviteRecord[] = [{ email: "late@ct.test", role: "TEAM_MEMBER", usedAt: null, expiresAt: "2025-01-01T00:00:00.000Z" }];
    expect(resolveSignup("late@ct.test", invites, NOW)).toEqual({ role: "VIEWER", active: false, matchedInvite: false });
  });

  it("an invite that expires in the future still matches", () => {
    const invites: InviteRecord[] = [{ email: "soon@ct.test", role: "TEAM_MEMBER", usedAt: null, expiresAt: "2099-01-01T00:00:00.000Z" }];
    expect(resolveSignup("soon@ct.test", invites, NOW)).toEqual({ role: "TEAM_MEMBER", active: true, matchedInvite: true });
  });

  it("a mismatched email never matches someone else's invite", () => {
    const invites: InviteRecord[] = [{ email: "someone-else@ct.test", role: "ADMIN", usedAt: null, expiresAt: null }];
    expect(resolveSignup("me@ct.test", invites, NOW)).toEqual({ role: "VIEWER", active: false, matchedInvite: false });
  });

  it("no email at all is never active", () => {
    expect(resolveSignup(null, [{ email: "x@ct.test", role: "ADMIN", usedAt: null, expiresAt: null }], NOW)).toEqual({ role: "VIEWER", active: false, matchedInvite: false });
  });

  it("picks a live invite among several for the same email (used ones ignored)", () => {
    const invites: InviteRecord[] = [
      { email: "multi@ct.test", role: "VIEWER", usedAt: "2025-01-01T00:00:00.000Z", expiresAt: null },
      { email: "multi@ct.test", role: "PRODUCTION_LEAD", usedAt: null, expiresAt: null },
    ];
    expect(resolveSignup("multi@ct.test", invites, NOW)).toEqual({ role: "PRODUCTION_LEAD", active: true, matchedInvite: true });
  });
});

/**
 * Sign-up / invite policy (CTOS-002A).
 *
 * Pure mirror of `ctos_handle_new_user()` in supabase/migrations/0002_identity_gateway.sql — the
 * database trigger that actually runs on every `auth.users` insert. Keep the two in sync; this
 * module exists so the rule ("registration order never grants ADMIN; an account is only active if
 * an invite matched") has an automated regression test, since the trigger itself has no local
 * Postgres harness to test against in this environment.
 *
 * There is deliberately no "first user becomes ADMIN" case any more. A fresh instance is bootstrapped
 * by inserting one ADMIN invite for the operator's own email before they sign in — see
 * docs/AUTH-AND-PERMISSIONS.md "Bootstrapping the first Admin".
 */
import type { UserRole } from "@/data/types";

export interface InviteRecord {
  email: string;
  role: UserRole;
  /** Set once the invite has been consumed by a sign-up; a used invite never matches again. */
  usedAt: string | null;
  /** Optional expiry; an expired invite never matches. */
  expiresAt: string | null;
}

export interface SignupAssignment {
  role: UserRole;
  /** false = the account exists but is inert: no reads, no writes, until an ADMIN activates it. */
  active: boolean;
  matchedInvite: boolean;
}

/** Case-insensitive, trims whitespace — matches the SQL `lower(email)` comparison. */
function normalizeEmail(email: string | null): string {
  return (email ?? "").trim().toLowerCase();
}

/**
 * Decide the role and activation state for a brand-new sign-up. A live (unused, unexpired) invite
 * for the exact email wins and grants its role, active immediately. Anything else — no invite, a
 * used invite, an expired invite, no email at all — becomes an inert VIEWER: readable by nobody,
 * writable by nobody, until an ADMIN flips `active` on (which never changes the fact that only an
 * ADMIN may also then change the role).
 */
export function resolveSignup(email: string | null, invites: InviteRecord[], now: string): SignupAssignment {
  const target = normalizeEmail(email);
  const match = target ? invites.find((i) => normalizeEmail(i.email) === target && !i.usedAt && (!i.expiresAt || i.expiresAt > now)) : undefined;
  if (match) return { role: match.role, active: true, matchedInvite: true };
  return { role: "VIEWER", active: false, matchedInvite: false };
}

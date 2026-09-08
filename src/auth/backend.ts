/**
 * Auth backends.
 *
 *  - SupabaseAuthBackend: real identity (Supabase Auth + profiles table). The session's access
 *    token is what the execution gateway verifies.
 *  - LocalAuthBackend: when Supabase is not configured. A named local identity with a chosen role,
 *    kept in sessionStorage, clearly labelled in the UI. It only ever talks to the embedded gateway
 *    with stub providers, so there is nothing to protect — but the same permission rules apply.
 */
import type { AuthUser, UserRole } from "@/data/types";

export interface AuthSession {
  user: AuthUser;
  /** Bearer token for the gateway ("local-session" in local mode). */
  token: string;
}

export interface AuthBackend {
  readonly kind: "supabase" | "local";
  getSession(): Promise<AuthSession | null>;
  signIn(input: { email: string; password: string } | { displayName: string; role: UserRole }): Promise<AuthSession>;
  signOut(): Promise<void>;
  onChange(cb: (session: AuthSession | null) => void): () => void;
}

export const ROLES: UserRole[] = ["ADMIN", "PRODUCTION_LEAD", "TEAM_MEMBER", "VIEWER"];
export const ROLE_LABELS: Record<UserRole, string> = { ADMIN: "Admin", PRODUCTION_LEAD: "Production Lead", TEAM_MEMBER: "Team Member", VIEWER: "Viewer" };

// ---------------------------------------------------------------------------
// Local mode
// ---------------------------------------------------------------------------

const LOCAL_KEY = "ctos.local-session";

export class LocalAuthBackend implements AuthBackend {
  readonly kind = "local" as const;
  private listeners = new Set<(s: AuthSession | null) => void>();
  private read(): AuthSession | null {
    try {
      const raw = globalThis.sessionStorage?.getItem(LOCAL_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as AuthSession;
      return parsed?.user?.id && ROLES.includes(parsed.user.role) ? parsed : null;
    } catch {
      return null;
    }
  }
  private write(s: AuthSession | null) {
    try {
      if (s) globalThis.sessionStorage?.setItem(LOCAL_KEY, JSON.stringify(s));
      else globalThis.sessionStorage?.removeItem(LOCAL_KEY);
    } catch {
      /* storage unavailable — session lives in memory for this page only */
    }
    this.memory = s;
    for (const l of this.listeners) l(s);
  }
  private memory: AuthSession | null = null;
  async getSession() {
    return this.read() ?? this.memory;
  }
  async signIn(input: { email: string; password: string } | { displayName: string; role: UserRole }) {
    if (!("displayName" in input)) throw new Error("Local mode signs in with a name and role");
    const name = input.displayName.trim();
    if (!name) throw new Error("Enter a name");
    const id = `local_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "user"}`;
    const session: AuthSession = { user: { id, email: null, displayName: name, role: input.role, active: true }, token: "local-session" };
    this.write(session);
    return session;
  }
  async signOut() {
    this.write(null);
  }
  onChange(cb: (s: AuthSession | null) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

// ---------------------------------------------------------------------------
// Supabase mode (structural client type — the SDK is imported only in services/supabase/client.ts)
// ---------------------------------------------------------------------------

interface SupabaseSessionLike {
  access_token: string;
  user: { id: string; email?: string | null };
}
export interface SupabaseAuthClientLike {
  auth: {
    getSession(): Promise<{ data: { session: SupabaseSessionLike | null } }>;
    signInWithPassword(creds: { email: string; password: string }): Promise<{ data: { session: SupabaseSessionLike | null }; error: { message: string } | null }>;
    signOut(): Promise<{ error: { message: string } | null }>;
    onAuthStateChange(cb: (event: string, session: SupabaseSessionLike | null) => void): { data: { subscription: { unsubscribe(): void } } };
  };
  from(table: string): { select(columns: string): { eq(column: string, value: unknown): { maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }> } } };
}

export class SupabaseAuthBackend implements AuthBackend {
  readonly kind = "supabase" as const;
  constructor(private readonly client: SupabaseAuthClientLike) {}

  private async toSession(s: SupabaseSessionLike | null): Promise<AuthSession | null> {
    if (!s) return null;
    const { data: profile } = await this.client.from("profiles").select("*").eq("id", s.user.id).maybeSingle();
    const role = profile && ROLES.includes(profile.role as UserRole) ? (profile.role as UserRole) : "VIEWER";
    const displayName = (profile?.display_name as string | undefined) || s.user.email || s.user.id;
    // Absent profile / absent column → treat as active (pre-migration, or a row RLS hid from us); an
    // explicit `active: false` is the only thing that blocks sign-in. The gateway re-checks this
    // independently from the service role, so UI gating here is not the only line of defence.
    const active = profile?.active !== false;
    return { user: { id: s.user.id, email: s.user.email ?? null, displayName, role, active }, token: s.access_token };
  }
  async getSession() {
    const { data } = await this.client.auth.getSession();
    return this.toSession(data.session);
  }
  async signIn(input: { email: string; password: string } | { displayName: string; role: UserRole }) {
    if (!("email" in input)) throw new Error("Supabase mode signs in with email and password");
    const { data, error } = await this.client.auth.signInWithPassword({ email: input.email.trim(), password: input.password });
    if (error) throw new Error(error.message);
    const session = await this.toSession(data.session);
    if (!session) throw new Error("Sign-in did not return a session");
    return session;
  }
  async signOut() {
    await this.client.auth.signOut();
  }
  onChange(cb: (s: AuthSession | null) => void) {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => {
      void this.toSession(session).then(cb);
    });
    return () => data.subscription.unsubscribe();
  }
}

/** Pick the backend from the environment: Supabase when configured, otherwise local mode. */
export async function createAuthBackend(env: { VITE_SUPABASE_URL?: string; VITE_SUPABASE_ANON_KEY?: string; VITE_CTOS_REPOSITORY?: string }): Promise<AuthBackend> {
  const url = env.VITE_SUPABASE_URL?.trim();
  const key = env.VITE_SUPABASE_ANON_KEY?.trim();
  if (url && key && env.VITE_CTOS_REPOSITORY !== "memory") {
    const { getSupabaseClient } = await import("@/services/supabase/client");
    return new SupabaseAuthBackend(getSupabaseClient(url, key) as unknown as SupabaseAuthClientLike);
  }
  return new LocalAuthBackend();
}

import * as React from "react";
import type { AuthUser, UserRole } from "@/data/types";
import type { AuthBackend, AuthSession } from "./backend";
import { LocalAuthBackend } from "./backend";

export interface AuthValue {
  user: AuthUser | null;
  token: string | null;
  kind: AuthBackend["kind"];
  loading: boolean;
  error: string | null;
  signIn: (input: { email: string; password: string } | { displayName: string; role: UserRole }) => Promise<void>;
  signOut: () => Promise<void>;
  /** Fresh token for gateway calls. */
  getToken: () => Promise<string | null>;
}

const AuthContext = React.createContext<AuthValue | null>(null);

export function AuthProvider({ backend, children }: { backend: AuthBackend | Promise<AuthBackend>; children: React.ReactNode }) {
  const [resolved, setResolved] = React.useState<AuthBackend | null>(backend instanceof Promise ? null : backend);
  const [session, setSession] = React.useState<AuthSession | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      let b: AuthBackend;
      try {
        b = backend instanceof Promise ? await backend : backend;
      } catch (err) {
        b = new LocalAuthBackend();
        if (!cancelled) setError(`Auth backend failed to start (${err instanceof Error ? err.message : String(err)}) — using local mode`);
      }
      if (cancelled) return;
      setResolved(b);
      const s = await b.getSession().catch(() => null);
      if (cancelled) return;
      setSession(s);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [backend]);

  React.useEffect(() => {
    if (!resolved) return;
    return resolved.onChange((s) => setSession(s));
  }, [resolved]);

  const value = React.useMemo<AuthValue>(
    () => ({
      user: session?.user ?? null,
      token: session?.token ?? null,
      kind: resolved?.kind ?? "local",
      loading,
      error,
      signIn: async (input) => {
        if (!resolved) throw new Error("Auth not ready");
        setError(null);
        try {
          setSession(await resolved.signIn(input));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          throw err;
        }
      },
      signOut: async () => {
        await resolved?.signOut();
        setSession(null);
      },
      getToken: async () => {
        if (!resolved) return null;
        const s = await resolved.getSession().catch(() => null);
        return s?.token ?? session?.token ?? null;
      },
    }),
    [resolved, session, loading, error],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

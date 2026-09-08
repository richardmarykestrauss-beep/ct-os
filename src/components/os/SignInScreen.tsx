import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROLES, ROLE_LABELS } from "@/auth/backend";
import { useAuth } from "@/auth/AuthProvider";
import type { UserRole } from "@/data/types";
import { Clock, LogIn, LogOut, ShieldCheck } from "lucide-react";

/** Full-page sign-in. Shown instead of the app whenever there is no session. */
export function SignInScreen() {
  const auth = useAuth();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<UserRole>("PRODUCTION_LEAD");
  const [busy, setBusy] = React.useState(false);
  const local = auth.kind === "local";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await auth.signIn(local ? { displayName: name, role } : { email, password });
    } catch {
      /* error is shown from auth.error */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-lg border bg-surface px-6 py-6 shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-md bg-accent text-[13px] font-bold text-white">CT</div>
          <div className="leading-tight">
            <div className="text-[15px] font-semibold text-ink">Website OS</div>
            <div className="text-[10px] uppercase tracking-wider text-muted">Creative Touch</div>
          </div>
        </div>
        <p className="mt-4 text-[13px] text-muted">{local ? "Local mode — Supabase is not configured. Choose a name and role for this session; providers are stubs." : "Sign in with your Creative Touch account."}</p>

        {local ? (
          <div className="mt-4 grid gap-3">
            <div>
              <Label htmlFor="name">Your name</Label>
              <Input id="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Richard" />
            </div>
            <div>
              <Label htmlFor="role">Role</Label>
              <NativeSelect id="role" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>
        ) : (
          <div className="mt-4 grid gap-3">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </div>
        )}

        {auth.error ? <div className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">{auth.error}</div> : null}

        <Button type="submit" variant="accent" className="mt-4 w-full" disabled={busy || (local ? !name.trim() : !email || !password)}>
          <LogIn /> {busy ? "Signing in…" : "Sign in"}
        </Button>
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted">
          <ShieldCheck className="size-3.5" /> Roles: Admin · Production Lead · Team Member · Viewer. Provider keys never reach this browser.
        </p>
      </form>
    </div>
  );
}

/**
 * Shown instead of the app when a signed-in Supabase account exists but is not yet active — a
 * self-registered sign-up with no matching invite. The account has a valid session but the gateway
 * (server-side, independent of this screen) also refuses to execute anything for it; this screen is
 * a courtesy, not the enforcement. See docs/AUTH-AND-PERMISSIONS.md "Sign-up and activation".
 */
export function PendingApprovalScreen() {
  const auth = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-lg border bg-surface px-6 py-6 text-center shadow-sm">
        <Clock className="mx-auto size-6 text-muted" />
        <div className="mt-3 text-[15px] font-semibold text-ink">Waiting for approval</div>
        <p className="mt-2 text-[13px] text-muted">
          {auth.user?.displayName ?? "This account"} was created without an invite, so it isn't active yet. An Admin needs to approve it before you can use Website OS.
        </p>
        <Button variant="outline" className="mt-4 w-full" onClick={() => void auth.signOut()}>
          <LogOut /> Sign out
        </Button>
      </div>
    </div>
  );
}

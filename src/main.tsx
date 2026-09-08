import { StrictMode } from "react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { OSStoreProvider } from "@/state/os-store";
import { createRepository } from "@/services/repository";
import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { createAuthBackend } from "@/auth/backend";
import { PendingApprovalScreen, SignInScreen } from "@/components/os/SignInScreen";
import { HttpGatewayClient, resolveGatewayUrl } from "@/gateway/client";
import "./styles.css";

const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Decided from the environment: Supabase (auth + persistence + HTTP gateway) when configured,
// otherwise local mode (named local identity, in-memory seed, embedded stub gateway).
const env = import.meta.env as unknown as Record<string, string | boolean | undefined>;
const authBackend = createAuthBackend(env as { VITE_SUPABASE_URL?: string; VITE_SUPABASE_ANON_KEY?: string; VITE_CTOS_REPOSITORY?: string });
const repository = createRepository();

function App() {
  const auth = useAuth();
  const gateway = React.useMemo(() => (auth.kind === "supabase" ? new HttpGatewayClient(resolveGatewayUrl(env), auth.getToken) : undefined), [auth.kind, auth.getToken]);
  if (auth.loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas text-[13px] text-muted" role="status">
        Checking session…
      </div>
    );
  }
  if (!auth.user) return <SignInScreen />;
  if (auth.user.active === false) return <PendingApprovalScreen />;
  return (
    <OSStoreProvider repository={repository} user={auth.user} gateway={gateway}>
      <RouterProvider router={router} />
    </OSStoreProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider backend={authBackend}>
      <App />
    </AuthProvider>
  </StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { OSStoreProvider } from "@/state/os-store";
import { createRepository } from "@/services/repository";
import "./styles.css";

// Decided from the environment: Supabase when configured, otherwise the in-memory seed.
const repository = createRepository();

const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OSStoreProvider repository={repository}>
      <RouterProvider router={router} />
    </OSStoreProvider>
  </StrictMode>,
);

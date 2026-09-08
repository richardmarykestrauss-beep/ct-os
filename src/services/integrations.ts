/**
 * Integration seams — control plane vs execution plane vs intelligence plane.
 *
 * The dashboard (control plane) records intent and state. External systems (execution plane)
 * do the actual work. Intelligence providers (Claude / OpenAI / Gemini) sit behind `src/ai`.
 * Integration descriptors now live in the store (`data.integrations`, table `integrations`);
 * this module keeps the adapter contracts and a static export for code that needs the list
 * without a store.
 */
import type { Integration, IntegrationStatus } from "@/data/types";
import { integrations } from "@/data/seed";

export type { IntegrationStatus };
export type IntegrationDescriptor = Integration;

export const INTEGRATIONS: Integration[] = integrations;

export const INTEGRATION_STATUS_LABELS: Record<IntegrationStatus, string> = {
  NOT_CONNECTED: "Not connected",
  STUB: "Stub — not connected",
  CONFIGURED: "Configured",
  FUTURE: "Future integration",
};

/** Adapter contracts. Implementations arrive with credentials later — never in this phase. */
export interface AgentRunner {
  runTicket(ticketId: string): Promise<{ output: string }>;
}
export interface SiteExecutor {
  openPreview(ref: { kind: "PREVIEW" | "TEMPLATE"; id: number }): Promise<string>;
}

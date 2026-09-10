/**
 * Client workflow service (CTOS-005A Part 20).
 *
 * Manages intake and client asset inventory lifecycle.
 * No website mutations. No direct client API calls. Data-layer only.
 */
import type {
  ClientAsset,
  ClientAssetStatus,
  IntakeStatus,
  OSData,
} from "@/data/types";
import { newId, nowIso } from "@/lib/core";

// ---------------------------------------------------------------------------
// Client asset inventory
// ---------------------------------------------------------------------------

/** Register a new client-supplied asset (logo, photo, copy doc, etc.). */
export function registerClientAsset(
  data: OSData,
  opts: {
    projectId: string;
    name: string;
    description: string;
    fileRef: string | null;
    notes: string | null;
  },
): { data: OSData; asset: ClientAsset } {
  const asset: ClientAsset = {
    id: newId("ca"),
    projectId: opts.projectId,
    name: opts.name,
    description: opts.description,
    status: "RECEIVED",
    fileRef: opts.fileRef,
    requestedAt: null,
    receivedAt: nowIso(),
    approvedAt: null,
    notes: opts.notes,
  };

  return { data: { ...data, clientAssets: [...data.clientAssets, asset] }, asset };
}

/** Update the status of a client asset through its review lifecycle. */
export function updateClientAssetStatus(
  data: OSData,
  assetId: string,
  newStatus: ClientAssetStatus,
): OSData {
  return {
    ...data,
    clientAssets: data.clientAssets.map((a) => {
      if (a.id !== assetId) return a;
      return {
        ...a,
        status: newStatus,
        approvedAt: newStatus === "APPROVED" ? nowIso() : a.approvedAt,
      };
    }),
  };
}

/** Get all assets for a project grouped by status. */
export function clientAssetsByStatus(data: OSData, projectId: string): Record<ClientAssetStatus, ClientAsset[]> {
  const assets = data.clientAssets.filter((a) => a.projectId === projectId);
  const grouped: Record<ClientAssetStatus, ClientAsset[]> = {
    REQUESTED: [],
    RECEIVED: [],
    APPROVED: [],
    REJECTED: [],
  };
  for (const a of assets) {
    const key = a.status as ClientAssetStatus;
    if (grouped[key]) grouped[key].push(a);
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// Intake summary
// ---------------------------------------------------------------------------

/** Return an intake status summary for a project. */
export function intakeSummary(
  data: OSData,
  projectId: string,
): { status: IntakeStatus; assetCounts: Record<ClientAssetStatus, number>; missingRequired: string[] } {
  const byStatus = clientAssetsByStatus(data, projectId);
  const assetCounts = Object.fromEntries(
    Object.entries(byStatus).map(([k, v]) => [k, v.length]),
  ) as Record<ClientAssetStatus, number>;

  const missingRequired: string[] = [];
  if (assetCounts.APPROVED === 0) missingRequired.push("At least one approved asset required");

  let status: IntakeStatus;
  if (missingRequired.length === 0 && assetCounts.APPROVED > 0) {
    status = "COMPLETE";
  } else if (assetCounts.RECEIVED > 0 || assetCounts.REQUESTED > 0) {
    status = "IN_PROGRESS";
  } else {
    status = "NOT_STARTED";
  }

  return { status, assetCounts, missingRequired };
}

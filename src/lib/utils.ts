import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

let counter = 0;
/**
 * String-safe ID generator: `<prefix>_<uuid>` when the platform offers crypto.randomUUID,
 * otherwise a time+counter fallback. IDs are plain `text` columns in Supabase, so seeded
 * readable ids (e.g. `proj_uproof`) and generated ids coexist.
 */
export function newId(prefix: string) {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `${prefix}_${c.randomUUID()}`;
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function formatRelative(iso?: string | null) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

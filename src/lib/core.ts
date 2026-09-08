/**
 * Runtime-neutral helpers shared by the browser, the Vite dev gateway and the Deno Edge Function.
 * Keep this file free of DOM, Node and UI dependencies.
 */
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

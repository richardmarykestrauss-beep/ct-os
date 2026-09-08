/**
 * The ONLY browser module that imports the Supabase SDK. Loaded lazily (dynamic import) so the SDK
 * is not part of the bundle unless Supabase is configured. One client instance is shared by the
 * repository (data) and the auth backend (session), so RLS sees the signed-in user.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClientLike } from "./repository";

let instance: { key: string; client: SupabaseClient } | null = null;

export function getSupabaseClient(url: string, anonKey: string): SupabaseClient {
  const key = `${url}::${anonKey.slice(0, 8)}`;
  if (!instance || instance.key !== key) instance = { key, client: createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } }) };
  return instance.client;
}

export function createSupabaseClient(url: string, anonKey: string): SupabaseClientLike {
  // The SDK's builder is thenable and structurally satisfies SupabaseQuery for the calls we make.
  return getSupabaseClient(url, anonKey) as unknown as SupabaseClientLike;
}

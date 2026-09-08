/**
 * The ONLY module that imports the Supabase SDK. Loaded lazily by the repository factory so the
 * SDK is not part of the bundle unless Supabase is configured.
 */
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClientLike } from "./repository";

export function createSupabaseClient(url: string, anonKey: string): SupabaseClientLike {
  const client = createClient(url, anonKey, { auth: { persistSession: true } });
  // The SDK's builder is thenable and structurally satisfies SupabaseQuery for the calls we make.
  return client as unknown as SupabaseClientLike;
}

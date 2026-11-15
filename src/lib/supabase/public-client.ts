import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { getPublicSupabaseEnvironment } from "./public-env";

/**
 * Reserved for future explicitly authorized public operations.
 * Not mounted by the current UI. This key grants no access to Relay tables.
 */
export function createPublicSupabaseClient() {
  const { url, publishableKey } = getPublicSupabaseEnvironment();
  return createClient<Database>(url, publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

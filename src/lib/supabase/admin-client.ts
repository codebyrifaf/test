import "server-only";

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { getServerSupabaseEnvironment } from "./server-env";

/** Privileged database client. Never return it or its configuration to a caller. */
export function createAdminSupabaseClient() {
  const { url, secretKey } = getServerSupabaseEnvironment();
  return createClient<Database>(url, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          cache: "no-store",
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        }),
    },
  });
}

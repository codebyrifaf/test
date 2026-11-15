import "server-only";

import { createAdminSupabaseClient } from "./admin-client";
import { SupabaseConfigurationError } from "./environment";

export type SupabaseHealthStatus =
  "ok" | "not_configured" | "invalid_configuration" | "unavailable";

/** A bounded HEAD query: no row contents or counts leave the database. */
export async function checkSupabaseConnection(): Promise<SupabaseHealthStatus> {
  try {
    const client = createAdminSupabaseClient();
    const { error } = await client
      .from("sessions")
      .select("id", { head: true })
      .limit(1)
      .abortSignal(AbortSignal.timeout(5_000));

    return error ? "unavailable" : "ok";
  } catch (error: unknown) {
    if (error instanceof SupabaseConfigurationError) {
      return error.issue === "missing"
        ? "not_configured"
        : "invalid_configuration";
    }
    // Network/SDK/database details are intentionally not public response data.
    return "unavailable";
  }
}

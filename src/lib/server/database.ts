import "server-only";
import { createAdminSupabaseClient } from "@/lib/supabase/admin-client";
import { SupabaseConfigurationError } from "@/lib/supabase/environment";
import type { Database } from "@/types/database";
import { AppError, databaseError } from "./errors";

export function database() {
  try {
    return createAdminSupabaseClient();
  } catch (error) {
    if (error instanceof SupabaseConfigurationError)
      throw new AppError("SETUP_REQUIRED", 503);
    throw error;
  }
}
type Functions = Database["public"]["Functions"];
export async function rpc<Name extends keyof Functions>(
  name: Name,
  args: Functions[Name]["Args"],
): Promise<Functions[Name]["Returns"]> {
  const { data, error } = await database().rpc(name, args);
  if (error) throw databaseError(error);
  return data as Functions[Name]["Returns"];
}

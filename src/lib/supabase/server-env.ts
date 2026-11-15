import "server-only";

import { requireSupabaseKey } from "./environment";
import { getPublicSupabaseEnvironment } from "./public-env";

export function getServerSupabaseEnvironment() {
  const publicEnvironment = getPublicSupabaseEnvironment();
  return {
    ...publicEnvironment,
    secretKey: requireSupabaseKey(
      process.env.SUPABASE_SECRET_KEY,
      "SUPABASE_SECRET_KEY",
      "secret",
    ),
  };
}

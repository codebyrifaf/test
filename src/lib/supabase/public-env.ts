import { requireSupabaseKey, requireSupabaseUrl } from "./environment";

/** Only public configuration is referenced here; Next.js inlines these names. */
export function getPublicSupabaseEnvironment() {
  return {
    url: requireSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL),
    publishableKey: requireSupabaseKey(
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "publishable",
    ),
  };
}

export type SupabaseConfigurationIssue = "missing" | "invalid";

/** Messages contain variable names only, never their values. */
export class SupabaseConfigurationError extends Error {
  constructor(
    public readonly issue: SupabaseConfigurationIssue,
    variable: string,
  ) {
    super(`Supabase configuration ${issue}: ${variable}.`);
    this.name = "SupabaseConfigurationError";
  }
}

export function requireSupabaseKey(
  value: string | undefined,
  variable: string,
  kind: "publishable" | "secret",
): string {
  if (!value?.trim()) {
    throw new SupabaseConfigurationError("missing", variable);
  }

  // Reject swapped key types, legacy JWTs, whitespace, and malformed values.
  const pattern = new RegExp(`^sb_${kind}_[A-Za-z0-9_-]+$`);
  if (!pattern.test(value)) {
    throw new SupabaseConfigurationError("invalid", variable);
  }
  return value;
}

export function requireSupabaseUrl(value: string | undefined): string {
  const variable = "NEXT_PUBLIC_SUPABASE_URL";
  if (!value?.trim()) {
    throw new SupabaseConfigurationError("missing", variable);
  }

  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const secure = url.protocol === "https:";
    const localHttp = url.protocol === "http:" && loopback;
    if (
      value !== value.trim() ||
      (!secure && !localHttp) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error("Invalid project URL");
    }
    return url.origin;
  } catch {
    throw new SupabaseConfigurationError("invalid", variable);
  }
}

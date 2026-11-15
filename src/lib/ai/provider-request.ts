import "server-only";

export class AIError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus?: number,
    public readonly retryAfterMs?: number,
    /** A used-up daily quota (as opposed to a per-minute limit). */
    public readonly dailyQuota = false,
  ) {
    super(code);
    this.name = "AIError";
  }
}

export function classifyProviderError(
  error: unknown,
  retryAfterMs?: number,
): AIError {
  if (error instanceof AIError) return error;
  if (
    error instanceof Error &&
    ["TimeoutError", "AbortError"].includes(error.name)
  )
    return new AIError("AI_TIMEOUT");
  const status =
    error && typeof error === "object" && "status" in error
      ? Number(error.status)
      : 0;
  const httpStatus =
    Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : undefined;
  const code =
    status === 429
      ? "AI_QUOTA"
      : status === 401 || status === 403
        ? "AI_AUTH"
        : status === 404
          ? "AI_MODEL_UNAVAILABLE"
          : status === 400
            ? "AI_INVALID_REQUEST"
            : "AI_UNAVAILABLE";
  // Google names the exhausted limit, for example ...PerDayPerProjectPerModel.
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message: unknown }).message)
      : "";
  return new AIError(
    code,
    httpStatus,
    retryAfterMs,
    status === 429 && /PerDay/i.test(message),
  );
}

export function retryAfterDelay(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? milliseconds
    : undefined;
}

/** Only timeouts and temporary provider/server failures are worth retrying. */
export function isRetryable(error: unknown): boolean {
  return (
    error instanceof AIError &&
    (error.code === "AI_TIMEOUT" ||
      (error.code === "AI_UNAVAILABLE" &&
        (error.httpStatus === undefined ||
          [500, 502, 503, 504].includes(error.httpStatus))))
  );
}

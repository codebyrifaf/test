import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

type Context = { correlationId: string; questionId?: string; stage?: string };
const context = new AsyncLocalStorage<Context>();
const categories = new Set([
  "AI_NOT_CONFIGURED",
  "AI_TIMEOUT",
  "AI_QUOTA",
  "AI_AUTH",
  "AI_MODEL_UNAVAILABLE",
  "AI_INVALID_REQUEST",
  "AI_UNAVAILABLE",
  "AI_RATE_LIMIT",
  "AI_INCOMPLETE",
  "AI_EMPTY_RESPONSE",
  "AI_INVALID_RESPONSE",
  "DATABASE_UNAVAILABLE",
  "SETUP_REQUIRED",
  "RATE_LIMITED",
  "UNAUTHORIZED",
  "SESSION_ENDED",
  "INVALID_INPUT",
  "FORBIDDEN_ORIGIN",
  "STORAGE_UNAVAILABLE",
  "PROCESSING_FAILED",
]);

// Only allowlisted metadata leaves the server. Never serialize an exception,
// request, prompt, answer, provider response body, cookie, or credential.
export function safeProcessingError(error: unknown) {
  const value =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  return {
    category:
      typeof value.code === "string" && categories.has(value.code)
        ? value.code
        : value.name === "TimeoutError"
          ? "AI_TIMEOUT"
          : "PROCESSING_FAILED",
    ...(Number.isInteger(value.httpStatus) &&
    Number(value.httpStatus) >= 100 &&
    Number(value.httpStatus) <= 599
      ? { providerHttpStatus: Number(value.httpStatus) }
      : {}),
    ...(typeof value.databaseCode === "string" &&
    /^(?:[A-Z0-9]{5}|PGRST\d{3})$/.test(value.databaseCode)
      ? { databaseCode: value.databaseCode }
      : {}),
  };
}

type Metadata = {
  durationMs?: number;
  timeoutMs?: number;
  attempt?: number;
  retryDelayMs?: number;
  modelSlot?: "primary" | "fallback";
  /** Gemini model name (no request content). */
  model?: string;
  /** Gemini's reason for ending a stream that did not finish normally. */
  finishReason?: string;
  outcome?:
    | "published"
    | "obsolete"
    | "cancelled"
    | "failed"
    | "acknowledged"
    | "ignored"
    | "prefetched"
    | "started";
};
export function processingEvent(
  event: string,
  metadata: Metadata = {},
  error?: unknown,
) {
  const current = context.getStore();
  if (!current) return;
  console.info(
    "[relay_processing]",
    JSON.stringify({
      timestamp: new Date().toISOString(),
      ...current,
      event,
      ...metadata,
      ...(error === undefined ? {} : safeProcessingError(error)),
    }),
  );
}

export function processingContext<T>(task: () => T, questionId?: string): T {
  return context.run(
    {
      correlationId: randomUUID(),
      ...context.getStore(),
      ...(questionId ? { questionId } : {}),
    },
    task,
  );
}
export function processingQuestion(questionId: string) {
  const current = context.getStore();
  if (current) current.questionId = questionId;
}
export function processingStage<T>(
  stage: string,
  task: () => Promise<T>,
): Promise<T> {
  const current = context.getStore();
  if (!current) return task();
  return context.run({ ...current, stage }, async () => {
    const started = performance.now();
    processingEvent("started");
    try {
      const result = await task();
      processingEvent("succeeded", {
        durationMs: Math.round(performance.now() - started),
      });
      return result;
    } catch (error) {
      processingEvent(
        "failed",
        { durationMs: Math.round(performance.now() - started) },
        error,
      );
      throw error;
    }
  });
}

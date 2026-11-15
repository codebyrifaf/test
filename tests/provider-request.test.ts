import assert from "node:assert/strict";
import test from "node:test";
import {
  AIError,
  classifyProviderError,
  isRetryable,
  retryAfterDelay,
} from "../src/lib/ai/provider-request";
import {
  processingContext,
  processingStage,
  safeProcessingError,
} from "../src/lib/server/processing-diagnostics";
import { databaseError } from "../src/lib/server/errors";

for (const [status, code, retryable] of [
  [429, "AI_QUOTA", false],
  [401, "AI_AUTH", false],
  [403, "AI_AUTH", false],
  [404, "AI_MODEL_UNAVAILABLE", false],
  [400, "AI_INVALID_REQUEST", false],
  [501, "AI_UNAVAILABLE", false],
  [500, "AI_UNAVAILABLE", true],
  [503, "AI_UNAVAILABLE", true],
  [504, "AI_UNAVAILABLE", true],
] as const) {
  test(`HTTP ${status} is ${code} and ${retryable ? "" : "not "}retryable`, () => {
    const error = classifyProviderError({ status, message: "private body" });
    assert.equal(error.code, code);
    assert.equal(error.httpStatus, status);
    assert.equal(isRetryable(error), retryable);
  });
}

test("timeouts and transport failures are retryable; content and app errors are not", () => {
  assert.equal(
    isRetryable(classifyProviderError(new DOMException("t", "TimeoutError"))),
    true,
  );
  assert.equal(isRetryable(classifyProviderError(new TypeError("reset"))), true);
  for (const code of [
    "AI_INVALID_RESPONSE",
    "AI_EMPTY_RESPONSE",
    "AI_INCOMPLETE",
    "AI_RATE_LIMIT",
    "AI_NOT_CONFIGURED",
  ])
    assert.equal(isRetryable(new AIError(code)), false);
  assert.equal(
    isRetryable(databaseError({ code: "PGRST202", message: "private" })),
    false,
  );
});

test("Retry-After values are parsed as seconds or HTTP dates", () => {
  assert.equal(classifyProviderError({ status: 503 }, 9000).retryAfterMs, 9000);
  assert.equal(retryAfterDelay("9"), 9000);
  assert.equal(
    retryAfterDelay(
      "Wed, 04 Nov 2026 01:00:09 GMT",
      Date.parse("2026-11-04T01:00:00Z"),
    ),
    9000,
  );
  assert.equal(retryAfterDelay("invalid"), undefined);
});

test("diagnostics correlate stages and redact content, credentials and raw error bodies", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  const error = Object.assign(new AIError("AI_UNAVAILABLE", 503), {
    message: "secret key question answer body",
    headers: { authorization: "private token" },
  });
  await assert.rejects(
    processingContext(
      () =>
        processingStage("candidate_match", async () => {
          throw error;
        }),
      "test-question-id",
    ),
  );
  const parsed = lines.map((line) =>
    JSON.parse(line.slice("[relay_processing] ".length)),
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].correlationId, parsed[1].correlationId);
  assert.equal(parsed[1].questionId, "test-question-id");
  assert.equal(parsed[1].stage, "candidate_match");
  assert.equal(parsed[1].providerHttpStatus, 503);
  assert.equal(typeof parsed[1].durationMs, "number");
  assert.ok(!lines.join().includes("secret"));
  assert.ok(!lines.join().includes("private token"));
  assert.deepEqual(
    safeProcessingError({
      code: "SECRET",
      httpStatus: "token",
      message: "secret",
    }),
    { category: "PROCESSING_FAILED" },
  );
});

test("a used-up daily quota is told apart from a per-minute limit", () => {
  const daily = classifyProviderError({
    status: 429,
    message: '{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}',
  });
  const minute = classifyProviderError({
    status: 429,
    message: '{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}',
  });
  assert.equal(daily.code, "AI_QUOTA");
  assert.equal(daily.dailyQuota, true);
  assert.equal(minute.dailyQuota, false);
  assert.equal(classifyProviderError({ status: 503, message: "PerDay" }).dailyQuota, false);
});

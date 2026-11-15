import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  aiConfiguration,
  clearModelCooldowns,
  streamAnswer,
} from "../src/lib/ai/provider";

const fast = { hedgeAfterMs: 60, firstTextTimeoutMs: 5000, attemptTimeoutMs: 10000 };

const names = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_FALLBACK_MODEL",
] as const;
const original = names.map((name) => process.env[name]);
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://relay-tests.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_failover_fixture";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_failover_fixture";
  process.env.GEMINI_API_KEY = "test-only-no-real-key";
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_FALLBACK_MODEL;
});
afterEach(() => {
  mock.restoreAll();
  clearModelCooldowns();
  names.forEach((name, i) => {
    if (original[i] === undefined) delete process.env[name];
    else process.env[name] = original[i];
  });
});
function transport(
  respond: (index: number, signal?: AbortSignal | null) => Response,
  budget: () => Response = () => Response.json(true),
) {
  const requests: {
    model: string;
    body: Record<string, unknown>;
    signal?: AbortSignal | null;
  }[] = [];
  let budgets = 0;
  mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(init?.cache, "no-store");
      if (
        url.hostname === "relay-tests.invalid" &&
        url.pathname.endsWith("/rpc/relay_rate_limit")
      ) {
        budgets++;
        return budget();
      }
      assert.equal(url.hostname, "generativelanguage.googleapis.com");
      const model = url.pathname.match(
        /\/models\/([^:]+):streamGenerateContent$/,
      )?.[1];
      assert.ok(model);
      requests.push({
        model,
        body: JSON.parse(String(init?.body)),
        signal: init?.signal,
      });
      return respond(requests.length, init?.signal);
    },
  );
  return { requests, budgetCount: () => budgets };
}
const event = (text: string, finishReason?: string) =>
  `data: ${JSON.stringify({
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        ...(finishReason ? { finishReason } : {}),
      },
    ],
  })}\r\n\r\n`;
const stream = (...texts: string[]) =>
  new Response(
    texts
      .map((text, i) =>
        event(text, i === texts.length - 1 ? "STOP" : undefined),
      )
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
const failure = (status: number) =>
  Response.json(
    {
      error: {
        code: status,
        status: status === 503 ? "UNAVAILABLE" : "ERROR",
        message: "Synthetic test response",
      },
    },
    { status },
  );
const prompt = {
  system: "RULES\n\nMEMORY:\nfacts",
  content: "LENGTH: 45 to 65 words (20 to 30 seconds).\nQUESTION: Synthetic?",
};

test("default models are the verified Flash-Lite pair and an empty backup disables switching", () => {
  assert.equal(aiConfiguration().model, "gemini-3.5-flash-lite");
  // 3.1 Flash-Lite is deliberately not a default backup (it invented facts).
  assert.deepEqual(aiConfiguration().fallbackModels, ["gemini-3.6-flash"]);
  assert.equal(aiConfiguration().fallbackModel, "gemini-3.6-flash");
  process.env.GEMINI_FALLBACK_MODEL = " gemini-3.6-flash , gemini-3.6-flash,x ";
  assert.deepEqual(aiConfiguration().fallbackModels, ["gemini-3.6-flash", "x"]);
  delete process.env.GEMINI_FALLBACK_MODEL;
  process.env.GEMINI_MODEL = "gemini-3.1-flash-lite";
  assert.equal(aiConfiguration().fallbackModel, "gemini-3.5-flash-lite");
  process.env.GEMINI_FALLBACK_MODEL = "";
  assert.equal(aiConfiguration().fallbackModel, null);
  process.env.GEMINI_FALLBACK_MODEL = process.env.GEMINI_MODEL;
  assert.equal(aiConfiguration().fallbackModel, null);
});

test("a second opinion asks the backup model first, and the main model when there is none", async () => {
  const state = transport(() => stream("It's £776 per year."));
  await streamAnswer({ ...prompt, preferBackup: true }, AbortSignal.timeout(10000), () => {});
  assert.deepEqual(state.requests.map((request) => request.model), ["gemini-3.6-flash"]);
  // The flag is not sent to Gemini.
  assert.doesNotMatch(JSON.stringify(state.requests[0].body), /preferBackup/);
  process.env.GEMINI_FALLBACK_MODEL = "";
  await streamAnswer({ ...prompt, preferBackup: true }, AbortSignal.timeout(10000), () => {});
  assert.equal(state.requests[1].model, "gemini-3.5-flash-lite");
});

test("text streams in order with the memory as system instruction and minimal thinking", async () => {
  const state = transport(() => stream("I studied ", "BBA in Dhaka."));
  const deltas: string[] = [];
  const full = await streamAnswer(prompt, AbortSignal.timeout(10000), (d) =>
    deltas.push(d),
  );
  assert.equal(full, "I studied BBA in Dhaka.");
  assert.deepEqual(deltas, ["I studied ", "BBA in Dhaka."]);
  const body = state.requests[0].body;
  assert.match(JSON.stringify(body.systemInstruction), /MEMORY:\\nfacts/);
  assert.match(JSON.stringify(body.contents), /QUESTION: Synthetic\?/);
  const config = body.generationConfig as Record<string, unknown>;
  assert.deepEqual(config.thinkingConfig, { thinkingLevel: "MINIMAL" });
  assert.equal(config.maxOutputTokens, 4096);
});

test("a 503 before any text switches to the backup immediately with the same request", async () => {
  const state = transport((attempt) =>
    attempt === 1 ? failure(503) : stream("Backup answer."),
  );
  const started = performance.now();
  assert.equal(
    await streamAnswer(prompt, AbortSignal.timeout(10000), () => {}),
    "Backup answer.",
  );
  assert.ok(performance.now() - started < 1500, "no backoff before switching");
  assert.deepEqual(
    state.requests.map((request) => request.model),
    ["gemini-3.5-flash-lite", "gemini-3.6-flash"],
  );
  assert.deepEqual(state.requests[0].body, state.requests[1].body);
  assert.equal(state.budgetCount(), 2);
});

test("backup failures stay within three attempts; only a repeat of the same model waits", async () => {
  const state = transport(() => failure(503));
  const started = performance.now();
  await assert.rejects(
    streamAnswer(prompt, AbortSignal.timeout(15000), () => {}),
    { code: "AI_UNAVAILABLE", httpStatus: 503 },
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 3000, "one short wait before retrying 3.6 Flash");
  assert.deepEqual(
    state.requests.map((request) => request.model),
    ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.6-flash"],
  );
  assert.equal(state.budgetCount(), 3);
});

for (const [status, code] of [
  [401, "AI_AUTH"],
  [400, "AI_INVALID_REQUEST"],
  [404, "AI_MODEL_UNAVAILABLE"],
] as const) {
  test(`HTTP ${status} does not trigger model switching`, async () => {
    const state = transport(() => failure(status));
    await assert.rejects(
      streamAnswer(prompt, AbortSignal.timeout(5000), () => {}),
      { code },
    );
    assert.equal(state.requests.length, 1);
  });
}

test("a used-up daily quota moves to the next model and skips that model afterwards", async () => {
  const state = transport((attempt) =>
    attempt === 1 ? failure(429) : stream("Answered by the backup."),
  );
  const started = performance.now();
  assert.equal(
    await streamAnswer(prompt, AbortSignal.timeout(10000), () => {}),
    "Answered by the backup.",
  );
  assert.ok(performance.now() - started < 1500, "no wait before switching");
  assert.deepEqual(
    state.requests.map((request) => request.model),
    ["gemini-3.5-flash-lite", "gemini-3.6-flash"],
  );
  // The next answer does not waste time on the exhausted model.
  await streamAnswer(prompt, AbortSignal.timeout(10000), () => {});
  assert.equal(state.requests[2].model, "gemini-3.6-flash");
});

test("when every model's quota is used up, the quota error is reported", async () => {
  const state = transport(() => failure(429));
  await assert.rejects(
    streamAnswer(prompt, AbortSignal.timeout(10000), () => {}),
    { code: "AI_QUOTA" },
  );
  assert.deepEqual(
    state.requests.map((request) => request.model),
    ["gemini-3.5-flash-lite", "gemini-3.6-flash"],
  );
});

/** Delivers `text`, then fails like Gemini's mid-stream "high demand" error. */
function breaksAfter(text: string) {
  const encoder = new TextEncoder();
  let pulls = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(encoder.encode(event(text)));
        else controller.error(new TypeError("connection reset"));
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

test("an answer that breaks off keeps the shown words and continues from them", async () => {
  const state = transport((attempt) =>
    attempt === 1 ? breaksAfter("I chose Leicester ") : stream("for its course."),
  );
  const deltas: string[] = [];
  const text = await streamAnswer(prompt, AbortSignal.timeout(10000), (d) =>
    deltas.push(d),
  );
  assert.equal(text, "I chose Leicester for its course.");
  assert.deepEqual(deltas, ["I chose Leicester ", "for its course."]);
  assert.equal(state.requests.length, 2);
  // The continuation goes to the other model, with the same rules and memory.
  assert.equal(state.requests[1].model, "gemini-3.6-flash");
  assert.deepEqual(
    state.requests[1].body.systemInstruction,
    state.requests[0].body.systemInstruction,
  );
  const contents = JSON.stringify(state.requests[1].body.contents);
  assert.match(contents, /ALREADY SAID:\\n<<<\\nI chose Leicester \\n>>>/);
  assert.match(contents, /QUESTION: Synthetic\?/);
});

test("a continuation after a full sentence never glues words together", async () => {
  transport((attempt) =>
    attempt === 1 ? breaksAfter("First point.") : stream("Second point."),
  );
  assert.equal(
    await streamAnswer(prompt, AbortSignal.timeout(10000), () => {}),
    "First point. Second point.",
  );
});

test("continuing alternates models up to three times, then reports the answer unfinished", async () => {
  const state = transport(() => breaksAfter("Again "));
  const deltas: string[] = [];
  await assert.rejects(
    streamAnswer(prompt, AbortSignal.timeout(10000), (d) => deltas.push(d)),
    { code: "AI_INCOMPLETE" },
  );
  assert.deepEqual(
    state.requests.map((request) => request.model),
    [
      "gemini-3.5-flash-lite",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.6-flash",
    ],
  );
  assert.deepEqual(deltas, ["Again ", "Again ", "Again ", "Again "]);
});

test("an answer cut off by the token limit is incomplete", async () => {
  transport(
    () =>
      new Response(event("Cut ", undefined) + event("off", "MAX_TOKENS"), {
        headers: { "Content-Type": "text/event-stream" },
      }),
  );
  await assert.rejects(
    streamAnswer(prompt, AbortSignal.timeout(10000), () => {}),
    { code: "AI_INCOMPLETE" },
  );
});

test("the request budget runs alongside the request and stops it without retrying", async () => {
  const exhausted = transport(
    () => stream("Should not be used."),
    () => Response.json(false),
  );
  await assert.rejects(
    streamAnswer(prompt, AbortSignal.timeout(10000), () => {}),
    { code: "AI_RATE_LIMIT" },
  );
  assert.equal(exhausted.budgetCount(), 1);
  assert.ok(exhausted.requests.length <= 1);
  mock.restoreAll();
  const unavailable = transport(
    () => stream("Should not be used."),
    () => Response.json({ code: "XX000", message: "down" }, { status: 500 }),
  );
  await assert.rejects(
    streamAnswer(prompt, AbortSignal.timeout(10000), () => {}),
    { code: "DATABASE_UNAVAILABLE" },
  );
  assert.equal(unavailable.budgetCount(), 1);
});

/** A response that sends `texts` after `delayMs`, or nothing until cancelled. */
function delayed(signal: AbortSignal | null | undefined, delayMs: number | null, ...texts: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        if (delayMs !== null)
          setTimeout(() => {
            if (signal?.aborted) return;
            texts.forEach((text, i) =>
              controller.enqueue(encoder.encode(event(text, i === texts.length - 1 ? "STOP" : undefined))),
            );
            controller.close();
          }, delayMs);
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

test("a silent primary is hedged: the backup's first text wins and the primary is cancelled", async () => {
  const state = transport((attempt, signal) =>
    attempt === 1 ? delayed(signal, null) : delayed(signal, 10, "Backup ", "answer."),
  );
  const deltas: string[] = [];
  const started = performance.now();
  const text = await streamAnswer(prompt, AbortSignal.timeout(10000), (d) => deltas.push(d), fast);
  assert.equal(text, "Backup answer.");
  assert.deepEqual(deltas, ["Backup ", "answer."]);
  assert.ok(performance.now() - started < 2000);
  assert.deepEqual(
    state.requests.map((request) => request.model),
    ["gemini-3.5-flash-lite", "gemini-3.6-flash"],
  );
  assert.equal(state.requests[0].signal?.aborted, true);
});

test("a primary that answers before the hedge delay never starts the backup", async () => {
  const state = transport((_attempt, signal) => delayed(signal, 5, "Primary."));
  assert.equal(
    await streamAnswer(prompt, AbortSignal.timeout(10000), () => {}, { ...fast, hedgeAfterMs: 2000 }),
    "Primary.",
  );
  assert.equal(state.requests.length, 1);
});

test("when the primary speaks first after hedging, only its text is shown and the backup is cancelled", async () => {
  const state = transport((attempt, signal) =>
    attempt === 1 ? delayed(signal, 200, "Primary ", "text.") : delayed(signal, null),
  );
  const deltas: string[] = [];
  assert.equal(
    await streamAnswer(prompt, AbortSignal.timeout(10000), (d) => deltas.push(d), fast),
    "Primary text.",
  );
  assert.deepEqual(deltas, ["Primary ", "text."]);
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[1].signal?.aborted, true);
});

test("cancelling the answer cancels every running request", async () => {
  const state = transport((_attempt, signal) => delayed(signal, null));
  const controller = new AbortController();
  const pending = streamAnswer(prompt, controller.signal, () => {}, fast);
  await new Promise((resolve) => setTimeout(resolve, 150));
  controller.abort(new Error("superseded"));
  await assert.rejects(pending, /superseded/);
  assert.equal(state.requests.length, 2);
  assert.ok(state.requests.every((request) => request.signal?.aborted));
});

test("a stream that ends without a normal finish is continued, not published as whole", async () => {
  const state = transport((attempt) =>
    attempt === 1
      ? new Response(event("Half of it "), {
          headers: { "Content-Type": "text/event-stream" },
        })
      : stream("and the rest."),
  );
  assert.equal(
    await streamAnswer(prompt, AbortSignal.timeout(10000), () => {}),
    "Half of it and the rest.",
  );
  assert.equal(state.requests.length, 2);
});

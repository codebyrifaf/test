import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { rateLimit } from "@/lib/server/security";
import { AppError } from "@/lib/server/errors";
import { processingEvent } from "@/lib/server/processing-diagnostics";
import {
  AIError,
  classifyProviderError,
  isRetryable,
  retryAfterDelay,
} from "./provider-request";
export { AIError } from "./provider-request";

export type StreamTiming = {
  /** Start the backup in parallel when the primary has sent no text yet. */
  hedgeAfterMs: number;
  /** Give up on an attempt that has sent no text within this time. */
  firstTextTimeoutMs: number;
  /** Upper bound for one attempt, including streaming. */
  attemptTimeoutMs: number;
};
const DEFAULT_TIMING: StreamTiming = {
  // Flash-Lite normally shows its first words within about 2.3 seconds.
  hedgeAfterMs: 2_500,
  firstTextTimeoutMs: 8_000,
  attemptTimeoutMs: 20_000,
};
const MAX_ATTEMPTS = 3;

// Each Gemini model has its own free daily quota. When one is used up, skip
// that model for a while so the next model in the chain answers instead.
const DAILY_QUOTA_COOLDOWN_MS = 30 * 60_000;
const MINUTE_QUOTA_COOLDOWN_MS = 60_000;
function quotaCooldownMs(error: unknown) {
  return error instanceof AIError && error.dailyQuota
    ? DAILY_QUOTA_COOLDOWN_MS
    : MINUTE_QUOTA_COOLDOWN_MS;
}
const cooldowns = ((
  globalThis as { __relayModelCooldowns?: Map<string, number> }
).__relayModelCooldowns ??= new Map<string, number>());
/** Models not cooling down after a quota error (all of them if none are). */
function usableModels(models: string[]) {
  const now = Date.now();
  const ready = models.filter((model) => (cooldowns.get(model) ?? 0) <= now);
  return ready.length ? ready : models;
}
/** For tests: forget quota cool-downs. */
export function clearModelCooldowns() {
  cooldowns.clear();
}

export function aiConfiguration() {
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  // Defaults are live-verified on this key's free tier (no billing, so no
  // charges possible). 3.6 Flash stayed available while both Flash-Lite
  // models were overloaded. 3.1 Flash-Lite is not a default backup: in live
  // tests it invented personal facts and ignored figures in the memory.
  // GEMINI_FALLBACK_MODEL takes a comma-separated list; empty disables backups.
  const configured = process.env.GEMINI_FALLBACK_MODEL;
  const backups =
    configured !== undefined
      ? configured.split(",")
      : model === "gemini-3.5-flash-lite"
        ? ["gemini-3.6-flash"]
        : ["gemini-3.5-flash-lite"];
  const fallbackModels = [
    ...new Set(backups.map((name) => name.trim()).filter(Boolean)),
  ].filter((name) => name !== model);
  return {
    model,
    fallbackModels,
    fallbackModel: fallbackModels[0] ?? null,
    thinkingLevel: thinkingLevel(),
    configured: Boolean(process.env.GEMINI_API_KEY),
  };
}

const THINKING_LEVELS = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
} as const;
const DEFAULT_THINKING_LEVEL: keyof typeof THINKING_LEVELS = "minimal";
/** How long Gemini 3 models think before answering (GEMINI_THINKING_LEVEL). */
function thinkingLevel(): keyof typeof THINKING_LEVELS {
  const value = process.env.GEMINI_THINKING_LEVEL?.trim().toLowerCase();
  return value && value in THINKING_LEVELS
    ? (value as keyof typeof THINKING_LEVELS)
    : DEFAULT_THINKING_LEVEL;
}
function client(
  timeoutMs: number,
  observeRetry?: (delay: number | undefined) => void,
) {
  if (!process.env.GEMINI_API_KEY) throw new AIError("AI_NOT_CONFIGURED");
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      timeout: timeoutMs,
      retryOptions: { attempts: 1 },
      // Private questions/memory must never enter Next's fetch cache.
      fetch: async (input, init) => {
        const response = await fetch(input, { ...init, cache: "no-store" });
        if (!response.ok)
          observeRetry?.(retryAfterDelay(response.headers.get("retry-after")));
        return response;
      },
    },
  });
}
async function budget() {
  // A web answer on an overloaded day can use several requests (memory,
  // lookup decision, web answer, backups), so allow 20 a minute by default.
  const configured = Number(process.env.GEMINI_REQUESTS_PER_MINUTE || 20);
  const limit =
    Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 20;
  try {
    await rateLimit("provider:generation", limit);
  } catch (error) {
    if (error instanceof AppError && error.code === "RATE_LIMITED")
      throw new AIError("AI_RATE_LIMIT");
    throw error;
  }
}

/** `system`: rules and memory (same for every question); `content`: this request. */
export type AnswerPrompt = {
  system: string;
  content: string;
  /** A second opinion: the backup models first, then the main model. */
  preferBackup?: boolean;
};

/**
 * One streamed request. `emit` returns false once another attempt has won,
 * after which this attempt is cancelled by its caller.
 */
async function streamAttempt(
  model: string,
  prompt: AnswerPrompt,
  signal: AbortSignal,
  timing: StreamTiming,
  emit: (delta: string) => boolean,
): Promise<string> {
  let retryAfterMs: number | undefined;
  let delivered = false;
  const firstText = new AbortController();
  const timer = setTimeout(
    () => firstText.abort(new AIError("AI_TIMEOUT")),
    timing.firstTextTimeoutMs,
  );
  const deadline = AbortSignal.timeout(timing.attemptTimeoutMs);
  const started = performance.now();
  // The persisted request budget is checked alongside the request rather
  // than before it, removing a database round trip from every answer.
  // An exhausted budget cancels the request immediately.
  const budgetDenied = new AbortController();
  let budgetError: unknown;
  const budgetCheck = budget().catch((error: unknown) => {
    budgetError = error;
    budgetDenied.abort(error);
  });
  try {
    const stream = await client(timing.attemptTimeoutMs, (value) => {
      retryAfterMs = value;
    }).models.generateContentStream({
      model,
      contents: prompt.content,
      config: {
        abortSignal: AbortSignal.any([
          signal,
          deadline,
          firstText.signal,
          budgetDenied.signal,
        ]),
        systemInstruction: prompt.system,
        // Gemini counts thinking against this cap, so leave room for both
        // the thinking and a 60–70 second answer (about 220 tokens).
        maxOutputTokens: 4096,
        // Gemini 3 models accept a thinking level: more thinking chooses
        // facts better but delays the first words (GEMINI_THINKING_LEVEL).
        ...(model.startsWith("gemini-3")
          ? {
              thinkingConfig: {
                thinkingLevel: THINKING_LEVELS[thinkingLevel()],
              },
            }
          : {}),
      },
    });
    let text = "";
    let finishReason: string | undefined;
    for await (const chunk of stream) {
      if (budgetError) throw budgetError;
      const delta = chunk.text ?? "";
      if (delta) {
        clearTimeout(timer);
        if (!emit(delta)) throw new Error("Another attempt answered first");
        delivered = true;
        text += delta;
      }
      finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
      if (finishReason === "MAX_TOKENS") throw new AIError("AI_INCOMPLETE");
    }
    await budgetCheck;
    if (budgetError) throw budgetError;
    if (!text.trim()) throw new AIError("AI_EMPTY_RESPONSE");
    // Only a normal finish is a complete answer; a stream that ends early
    // (safety stop, cut connection) must not be published as if it were whole.
    if (finishReason !== "STOP") {
      processingEvent("stream_unfinished", {
        durationMs: Math.round(performance.now() - started),
        finishReason: finishReason ?? "none",
      });
      throw new AIError("AI_INCOMPLETE");
    }
    return text;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    await budgetCheck;
    // Budget/database errors keep their own category and are never retried.
    if (budgetError) throw budgetError;
    if (error instanceof AppError) throw error;
    const safe =
      (firstText.signal.aborted || deadline.aborted) && !delivered
        ? new AIError("AI_TIMEOUT")
        : classifyProviderError(error, retryAfterMs);
    if (delivered && safe.code !== "AI_INCOMPLETE")
      // Record why a stream broke after text appeared (category only).
      processingEvent(
        "stream_interrupted",
        { durationMs: Math.round(performance.now() - started) },
        safe,
      );
    // Text already reached the viewer: report it unfinished, never retry.
    throw delivered && safe.code !== "AI_INCOMPLETE"
      ? new AIError("AI_INCOMPLETE", safe.httpStatus)
      : safe;
  } finally {
    clearTimeout(timer);
  }
}

// One continuation per model in the chain, so an overloaded model is skipped.
const MAX_CONTINUATIONS = 3;

/** Request to finish an answer that broke off after `said` was shown. */
export function continuationContent(content: string, said: string) {
  return `${content}\n\nYou were interrupted while saying this answer aloud. ALREADY SAID:\n<<<\n${said}\n>>>\nContinue from exactly where ALREADY SAID stops. Reply with only the remaining words: never repeat anything already said, and begin with a space if the next word is a new word. Finish the answer naturally within the LENGTH, ending with a short concluding sentence.`;
}

/** Joins a continuation to the shown text without gluing two words together. */
export function joinBoundary(shown: string, next: string) {
  if (!shown || /\s$/.test(shown) || /^\s/.test(next)) return next;
  return /[.,;:!?)]$/.test(shown) && /^[\p{L}\p{N}£$]/u.test(next)
    ? ` ${next}`
    : next;
}

/**
 * Streams one answer.
 * - The primary starts at once. If it has sent no text after `hedgeAfterMs`,
 *   the backup starts in parallel; whichever sends text first is used and the
 *   other is cancelled, so the viewer never sees two answers mixed.
 * - A transient failure before any text starts the next attempt immediately
 *   (backup model); quota, authentication and invalid-request errors do not.
 *   At most three such attempts.
 * - If the answer breaks off after text was shown (for example Gemini's
 *   "high demand" error mid-stream), the shown words stay and the rest is
 *   requested as a continuation, up to three times, rotating models. The viewer
 *   reads far slower than Gemini writes, so this is normally unnoticeable.
 */
export async function streamAnswer(
  prompt: AnswerPrompt,
  signal: AbortSignal,
  onText: (delta: string) => void,
  timing: StreamTiming = DEFAULT_TIMING,
): Promise<string> {
  signal.throwIfAborted();
  const config = aiConfiguration();
  return new Promise<string>((resolve, reject) => {
    const running = new Map<number, AbortController>();
    let launched = 0;
    let winner = 0;
    let settled = false;
    /** Everything delivered to the viewer so far, across continuations. */
    let shown = "";
    let continuations = 0;
    /** Models already used for this answer's first attempts. */
    const tried = new Set<string>();
    const nextModel = () => {
      const chain = usableModels(
        prompt.preferBackup
          ? [...config.fallbackModels, config.model]
          : [config.model, ...config.fallbackModels],
      );
      return chain.find((model) => !tried.has(model)) ?? chain[chain.length - 1];
    };
    let hedge: ReturnType<typeof setTimeout> | undefined;
    const settle = (error: unknown, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedge);
      signal.removeEventListener("abort", cancelled);
      for (const controller of running.values())
        controller.abort(new Error("Answer settled"));
      if (text !== undefined) resolve(text);
      else reject(error);
    };
    const cancelled = () => settle(signal.reason);
    signal.addEventListener("abort", cancelled, { once: true });

    const launch = () => {
      if (settled || winner || launched >= MAX_ATTEMPTS) return;
      const attempt = ++launched;
      // Main model first, then the backups in order, skipping models whose
      // quota is used up; once all have been tried, the last one repeats.
      const model = nextModel();
      tried.add(model);
      const useFallback = model !== config.model;
      const controller = new AbortController();
      running.set(attempt, controller);
      const started = performance.now();
      processingEvent("model_attempt", {
        attempt,
        modelSlot: useFallback ? "fallback" : "primary",
        model,
      });
      if (attempt === 1 && config.fallbackModel !== null)
        hedge = setTimeout(() => {
          if (!winner && running.size > 0) {
            processingEvent("provider_hedge", { attempt: 2 });
            launch();
          }
        }, timing.hedgeAfterMs);
      streamAttempt(model, prompt, controller.signal, timing, (delta) => {
        if (settled || (winner && winner !== attempt)) return false;
        if (!winner) {
          winner = attempt;
          clearTimeout(hedge);
          for (const [other, loser] of running)
            if (other !== attempt) loser.abort(new Error("Hedge lost"));
        }
        shown += delta;
        onText(delta);
        return true;
      }).then(
        (text) => {
          running.delete(attempt);
          processingEvent("provider_succeeded", {
            attempt,
            durationMs: Math.round(performance.now() - started),
          });
          settle(undefined, text);
        },
        (error: unknown) => {
          running.delete(attempt);
          // Hedging only covers a primary that is still waiting.
          if (attempt === 1) clearTimeout(hedge);
          if (settled || (winner && winner !== attempt)) return;
          processingEvent(
            "provider_failed",
            { attempt, durationMs: Math.round(performance.now() - started) },
            error,
          );
          // Quota used up: this model is skipped for a while; another model
          // (with its own quota) can still answer.
          const quota = error instanceof AIError && error.code === "AI_QUOTA";
          if (quota) cooldowns.set(model, Date.now() + quotaCooldownMs(error));
          // Broke off after text was shown: keep it and request the rest.
          if (winner === attempt) return rescue(error);
          if ((!isRetryable(error) && !quota) || (quota && nextModel() === model)) {
            // Nothing else to try: still let a parallel attempt finish.
            if (running.size === 0) settle(error);
            return;
          }
          if (running.size > 0) return; // A parallel attempt is still going.
          if (launched >= MAX_ATTEMPTS) return settle(error);
          // Switching to a different model needs no wait; retrying the same
          // model waits briefly.
          const wait =
            nextModel() !== model
              ? 0
              : Math.min(
                  Math.max(
                    error instanceof AIError ? (error.retryAfterMs ?? 0) : 0,
                    1000,
                  ),
                  5000,
                );
          processingEvent("provider_retry", { attempt, retryDelayMs: wait });
          delay(wait, undefined, { signal }).then(launch, () => {});
        },
      );
    };

    // Continue a broken answer from the words already shown.
    const rescue = (error: unknown) => {
      if (settled) return;
      const rescuable =
        error instanceof AIError &&
        (error.code === "AI_INCOMPLETE" ||
          error.code === "AI_QUOTA" ||
          isRetryable(error));
      if (!rescuable || continuations >= MAX_CONTINUATIONS)
        return settle(error);
      const number = ++continuations;
      // Rotate through the chain starting with the first backup:
      // 3.6 Flash, then the main model, then 3.1 Flash-Lite, skipping any
      // model whose quota is used up.
      const rotation = usableModels(
        config.fallbackModels.length
          ? [config.fallbackModels[0], config.model, ...config.fallbackModels.slice(1)]
          : [config.model],
      );
      const model = rotation[(number - 1) % rotation.length];
      const useFallback = model !== config.model;
      const key = 1000 + number;
      const controller = new AbortController();
      running.set(key, controller);
      const started = performance.now();
      processingEvent("stream_continued", {
        attempt: number,
        modelSlot: useFallback ? "fallback" : "primary",
        model,
      });
      let first = true;
      streamAttempt(
        model,
        { system: prompt.system, content: continuationContent(prompt.content, shown) },
        controller.signal,
        timing,
        (delta) => {
          if (settled) return false;
          const piece = first ? joinBoundary(shown, delta) : delta;
          first = false;
          shown += piece;
          onText(piece);
          return true;
        },
      ).then(
        () => {
          running.delete(key);
          processingEvent("provider_succeeded", {
            attempt: number,
            durationMs: Math.round(performance.now() - started),
          });
          settle(undefined, shown);
        },
        (failure: unknown) => {
          running.delete(key);
          if (settled) return;
          processingEvent(
            "provider_failed",
            { attempt: number, durationMs: Math.round(performance.now() - started) },
            failure,
          );
          if (failure instanceof AIError && failure.code === "AI_QUOTA")
            cooldowns.set(model, Date.now() + quotaCooldownMs(failure));
          rescue(failure);
        },
      );
    };
    launch();
  });
}

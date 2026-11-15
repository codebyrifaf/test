import "server-only";
import { rpc } from "@/lib/server/database";
import { record, text } from "@/lib/server/validation";
import { publishLive } from "@/lib/server/live-channel";
import { AIError } from "./provider";
import { startAnswer, type AnswerRun } from "./pipeline";
import type { AnswerLength } from "@/types/session";
import {
  processingContext,
  processingEvent,
  processingQuestion,
  processingStage,
} from "@/lib/server/processing-diagnostics";

// In-process optimizations only. Database leases and latest-question checks
// are authoritative across processes, server restarts, and overlapping requests.
type WorkerState = {
  active: Map<string, { questionId: string; run: AnswerRun }>;
  pending: Map<string, { run: AnswerRun; timer: ReturnType<typeof setTimeout> }>;
  lengths?: Map<string, { length: AnswerLength; at: number }>;
};
const state: WorkerState = ((
  globalThis as { __relayWorker?: WorkerState }
).__relayWorker ??= { active: new Map(), pending: new Map() });
const lengths = (state.lengths ??= new Map());
const UNCLAIMED_RUN_MS = 30_000;
const LENGTH_MEMORY_MS = 10 * 60_000;

/** The chosen length, so a recovered (restarted) answer keeps it. */
function rememberLength(questionId: string, length: AnswerLength) {
  const now = Date.now();
  for (const [id, entry] of lengths)
    if (now - entry.at > LENGTH_MEMORY_MS) lengths.delete(id);
  lengths.set(questionId, { length, at: now });
}

/** An answer started while the question was still being saved. */
export function registerPendingRun(
  questionId: string,
  run: AnswerRun,
  length: AnswerLength,
) {
  rememberLength(questionId, length);
  const timer = setTimeout(() => {
    if (state.pending.get(questionId)?.run === run) {
      state.pending.delete(questionId);
      run.abort(new Error("unclaimed"));
    }
  }, UNCLAIMED_RUN_MS);
  timer.unref?.();
  state.pending.get(questionId)?.run.abort(new Error("replaced"));
  state.pending.set(questionId, { run, timer });
}
function takePendingRun(questionId: string) {
  const pending = state.pending.get(questionId);
  if (!pending) return undefined;
  clearTimeout(pending.timer);
  state.pending.delete(questionId);
  return pending.run;
}

export async function processLatestQuestion(sessionId: string): Promise<void> {
  return processingContext(() => processClaimedQuestion(sessionId));
}

async function processClaimedQuestion(sessionId: string): Promise<void> {
  let questionId: string | undefined;
  let leaseId: string | undefined;
  let run: AnswerRun | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const raw = await rpc("relay_claim_question", { p_session_id: sessionId });
    if (!raw) return;
    const claim = record(raw);
    questionId = text(claim.id, 36);
    const id = questionId;
    processingQuestion(id);
    processingEvent("claimed", { timeoutMs: 60_000 });
    leaseId = text(claim.leaseId, 36);
    const prefetched = takePendingRun(id);
    const current: AnswerRun =
      prefetched ??
      startAnswer(text(claim.text, 12_000), {
        length: lengths.get(id)?.length ?? "short",
      });
    run = current;
    processingEvent("answer_run", {
      outcome: prefetched ? "prefetched" : "started",
    });
    const previous = state.active.get(sessionId);
    if (previous && previous.questionId !== id)
      previous.run.abort(new Error("superseded"));
    state.active.set(sessionId, { questionId: id, run: current });
    // Stream visible text to this process's viewer connections immediately.
    unsubscribe = current.subscribe((visible: string) => {
      if (state.active.get(sessionId)?.run === current)
        publishLive(sessionId, { type: "stream", id, text: visible });
    });
    const answer = await current.result;
    const published = await processingStage("publication", () =>
      rpc("relay_finish_question", {
        p_question_id: id,
        p_lease_id: leaseId!,
        p_answer: answer,
      }),
    );
    publishLive(
      sessionId,
      published ? { type: "published", id } : { type: "stream_end", id },
    );
    processingEvent("finished", {
      outcome: published ? "published" : "obsolete",
    });
  } catch (error) {
    if (questionId) publishLive(sessionId, { type: "stream_end", id: questionId });
    if (run?.cancelled) {
      processingEvent("finished", { outcome: "cancelled" });
      return;
    }
    processingEvent("worker_failed", { outcome: "failed" }, error);
    if (!questionId || !leaseId) return;
    const code =
      error instanceof AIError
        ? error.code
        : error instanceof DOMException && error.name === "TimeoutError"
          ? "AI_TIMEOUT"
          : error instanceof Error &&
              "code" in error &&
              error.code === "STORAGE_UNAVAILABLE"
            ? "STORAGE_UNAVAILABLE"
            : "PROCESSING_FAILED";
    try {
      const failure = {
        p_question_id: questionId,
        p_lease_id: leaseId,
        p_answer: null,
        p_error_code: code,
      };
      const recorded = await processingStage("failure_publication", () =>
        rpc("relay_finish_question", failure),
      );
      processingEvent("failure_recorded", {
        outcome: recorded ? "failed" : "obsolete",
      });
    } catch (publicationError) {
      processingEvent("lease_recovery_required", {}, publicationError);
      /* Durable lease recovery happens on a later heartbeat if DB access failed. */
    }
  } finally {
    unsubscribe?.();
    if (run && state.active.get(sessionId)?.run === run)
      state.active.delete(sessionId);
  }
}

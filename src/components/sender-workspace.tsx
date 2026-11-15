"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ClientError, post, requestId } from "@/lib/client-api";
import type {
  AnswerLength,
  QuestionReceipt,
  SenderSnapshot,
} from "@/types/session";

const processingErrors: Record<string, string> = {
  AI_UNAVAILABLE:
    "The answer service is temporarily unavailable after retrying. Please try again shortly. No error was sent to the viewer.",
  AI_QUOTA: "Gemini's quota is exhausted. Try again after your quota resets.",
  AI_AUTH:
    "The Gemini key was rejected. Ask the administrator to check the server configuration.",
  AI_MODEL_UNAVAILABLE:
    "The configured Gemini model is unavailable. Ask the administrator to select an available model.",
  AI_RATE_LIMIT:
    "The configured AI request budget is currently used. Try again shortly.",
  AI_TIMEOUT: "Answer generation timed out. You can submit another question.",
  AI_NOT_CONFIGURED:
    "Gemini is not configured on the server. Prepared exact matches can still be used.",
  AI_EMPTY_RESPONSE:
    "Gemini returned no answer. No error was sent to the viewer.",
  AI_INCOMPLETE:
    "Gemini could not finish the answer. An incomplete answer was not delivered.",
  AI_INVALID_RESPONSE:
    "Gemini returned an invalid matching response. Please try again.",
};

export function SenderWorkspace() {
  const [state, setState] = useState<SenderSnapshot | null>(null);
  const [question, setQuestion] = useState("");
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(0);
  const [receipt, setReceipt] = useState<QuestionReceipt | null>(null);
  const [retry, setRetry] = useState<{
    question: string;
    requestId: string;
    length: AnswerLength;
  } | null>(null);
  const refresh = useCallback(async (heartbeat = false) => {
    try {
      const next = heartbeat
        ? await post<SenderSnapshot>("/api/session/sender")
        : await api<SenderSnapshot>("/api/session/sender");
      setState(next);
      setConnected(true);
    } catch (error) {
      setConnected(false);
      if (
        error instanceof ClientError &&
        ["UNAUTHORIZED", "SESSION_ENDED"].includes(error.code)
      ) {
        setEnded(true);
        setState(null);
      }
      setError(
        error instanceof Error ? error.message : "Connection unavailable.",
      );
    }
  }, []);
  useEffect(() => {
    if (ended) return;
    const initial = setTimeout(() => void refresh(true), 0);
    const poll = setInterval(() => void refresh(), 2000);
    const heartbeat = setInterval(() => void refresh(true), 15_000);
    return () => {
      clearTimeout(initial);
      clearInterval(poll);
      clearInterval(heartbeat);
    };
  }, [refresh, ended]);
  async function submit(
    length: AnswerLength,
    payload = { question, requestId: requestId(), length },
  ) {
    if (!payload.question.trim()) return;
    setQuestion("");
    setError("");
    setRetry(null);
    setSending((count) => count + 1);
    try {
      const next = await post<QuestionReceipt>("/api/questions", payload);
      setReceipt((previous) =>
        !previous || next.sequence >= previous.sequence ? next : previous,
      );
      void refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Submission failed.");
      if (error instanceof ClientError && error.code === "NETWORK")
        setRetry(payload);
    } finally {
      setSending((count) => count - 1);
    }
  }
  async function quit() {
    try {
      await post("/api/session/quit", { role: "sender" });
      setEnded(true);
      setConnected(false);
      setState(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not quit.");
    }
  }
  const current =
    state?.question && (!receipt || state.question.sequence >= receipt.sequence)
      ? state.question
      : receipt;
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <span className="status-badge">
          {ended
            ? "Session unavailable"
            : connected
              ? "Connected"
              : "Reconnecting…"}
        </span>
        {state && (
          <button onClick={quit} className="button border-line text-sm">
            Quit session
          </button>
        )}
      </div>
      {state && (
        <p className="panel mb-6 text-sm">
          Private session code:{" "}
          <strong className="ml-2 select-all font-mono text-violet-200">
            {state.sessionCode}
          </strong>
          <span className="mt-2 block text-xs text-muted">
            Viewer {state.viewerConnected ? "connected" : "not connected"}.
            Share this code privately with Person B.
          </span>
        </p>
      )}
      {error && (
        <p role="alert" className="mb-5 text-sm text-rose-300">
          {error}
        </p>
      )}
      {ended ? (
        <Link href="/" className="preview-link justify-start text-violet-300">
          Return home to create or join a session
        </Link>
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
          <section className="panel">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit("short");
              }}
            >
              <label htmlFor="question" className="field-label">
                Your question
              </label>
              <textarea
                id="question"
                rows={8}
                maxLength={12000}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    if (connected)
                      void submit(
                        event.shiftKey
                          ? "long"
                          : event.altKey
                            ? "medium"
                            : "short",
                      );
                  }
                }}
                className="text-input mt-3"
                placeholder="What would you like to ask?"
              />
              <p className="control-note mt-3">
                Choose the answer length to send. Keyboard: Ctrl+Enter / ⌘+Enter
                sends 20–30 sec, add Alt / Option for 40 sec, or Shift for
                60–70 sec. You can send another question while an answer is
                processing.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                {(
                  [
                    ["short", "20–30 sec"],
                    ["medium", "40 sec"],
                    ["long", "60–70 sec"],
                  ] as const
                ).map(([length, label]) => (
                  <button
                    key={length}
                    type="button"
                    disabled={!connected || !question.trim()}
                    onClick={() => void submit(length)}
                    className="button button-sender"
                    data-testid={`send-${length}`}
                  >
                    {label}
                  </button>
                ))}
                <span className="text-xs text-muted">
                  {sending > 0
                    ? `Sending ${sending} request${sending > 1 ? "s" : ""}…`
                    : ""}
                </span>
              </div>
            </form>
            {retry && (
              <button
                className="preview-link text-violet-300"
                onClick={() => submit(retry.length, retry)}
              >
                Retry the interrupted submission
              </button>
            )}
          </section>
          <section className="panel" aria-live="polite">
            <h2 className="text-sm font-semibold">Question status</h2>
            <p className="mt-5 text-lg capitalize">
              {current?.status || "Ready for a question"}
            </p>
            {current && (
              <p className="control-note mt-2">
                Submission #{current.sequence}
              </p>
            )}
            {state?.question?.errorCode && (
              <p className="mt-4 text-sm leading-6 text-rose-300">
                {processingErrors[state.question.errorCode] ||
                  "This question could not be answered. Please try again. No error was sent to the viewer."}
              </p>
            )}
            {state?.question?.status === "completed" && (
              <p className="mt-4 text-sm text-teal-200">
                {state.question.delivered
                  ? "Delivered to the viewer."
                  : "Answer ready. Waiting for viewer delivery."}
              </p>
            )}
            <p className="control-note mt-6">
              Only the newest question is eligible for delivery. Answers are
              never shown in this workspace.
            </p>
          </section>
        </div>
      )}
    </>
  );
}

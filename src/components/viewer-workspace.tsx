"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, ClientError, post } from "@/lib/client-api";
import type { LiveAnswer, ViewerSnapshot } from "@/types/session";
import { AnswerTicker } from "./answer-ticker";
import { readAnswerMarker } from "@/lib/answer-marker";

export function ViewerWorkspace() {
  // Default is the measured reading speed answer lengths are sized for.
  const [speed, setSpeed] = useState(260);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem("relay-scroll-speed"));
      if (Number.isFinite(saved) && saved >= 40 && saved <= 400)
        setTimeout(() => setSpeed(saved), 0);
    } catch {
      /* Storage unavailable: keep the default. */
    }
  }, []);
  const changeSpeed = (value: number) => {
    setSpeed(value);
    try {
      localStorage.setItem("relay-scroll-speed", String(value));
    } catch {
      /* Storage unavailable: the speed still applies to this page. */
    }
  };
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [playback, setPlayback] = useState<{
    answer: LiveAnswer;
    key: number;
    final: boolean;
  } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState("");
  const display = useRef<HTMLDivElement>(null);
  // Text from the internet or made up is marked: at the start (the whole
  // answer) or after the memory part (added to a short memory answer). The
  // marker is replaced by a badge and coloured text (amber web, blue made up).
  const { text: shownText, marked } = readAnswerMarker(playback?.answer.text ?? "");
  const badge = !marked
    ? ""
    : marked.source === "web"
      ? marked.from === 0
        ? "From the internet — not from your memory"
        : "Amber part is from the internet — not from your memory"
      : marked.from === 0
        ? "Made up — not from your memory"
        : "Blue part is made up — not from your memory";
  useEffect(() => {
    let disposed = false;
    let source: EventSource | undefined;
    if (ended) return;
    let streamOpen = false;
    let offline = false;
    let lastAnswerId = "";
    let latestTime = "";
    let generation = 0;
    let stopped = false;
    let acknowledged = "";
    let acknowledging = false;
    let networkEpoch = 0;
    // An answer being generated right now, shown before it is published.
    let streaming: {
      id: string;
      /** Answers older than this stream; a late read must not replay them. */
      older: Set<string>;
      timer: ReturnType<typeof setTimeout>;
    } | null = null;
    let publishedId = "";
    const markFinal = (id: string, answer?: LiveAnswer) =>
      setPlayback((current) =>
        current && current.answer.id === id
          ? { ...current, answer: answer ?? current.answer, final: true }
          : current,
      );
    const endStream = (id: string, failed: boolean) => {
      if (!streaming || streaming.id !== id) return;
      clearTimeout(streaming.timer);
      // Not published: the previous answer must not replay afterwards.
      if (failed) lastAnswerId = publishedId;
      streaming = null;
      markFinal(id);
    };
    const streamText = (id: string, text: string) => {
      if (disposed || stopped || !navigator.onLine || !text) return;
      setConnected(true);
      if (streaming?.id === id) {
        clearTimeout(streaming.timer);
        streaming.timer = setTimeout(() => endStream(id, true), 30_000);
        setPlayback((current) =>
          current && current.answer.id === id
            ? { ...current, answer: { ...current.answer, text } }
            : current,
        );
        return;
      }
      if (id === lastAnswerId) return; // Already published and shown.
      if (streaming) clearTimeout(streaming.timer);
      streaming = {
        id,
        older: new Set([...(streaming?.older ?? []), lastAnswerId]),
        timer: setTimeout(() => endStream(id, true), 30_000),
      };
      lastAnswerId = id;
      setPlayback({
        answer: { id, text, updatedAt: "" },
        key: ++generation,
        final: false,
      });
    };
    const finish = () => {
      if (!disposed) {
        stopped = true;
        if (streaming) clearTimeout(streaming.timer);
        streaming = null;
        setEnded(true);
        setConnected(false);
        setPlayback(null);
        source?.close();
      }
    };
    const apply = (snapshot: ViewerSnapshot) => {
      if (disposed || stopped || !navigator.onLine) return;
      setConnected(true);
      if (snapshot.answer && streaming) {
        // A read that started before publication still has the older answer.
        if (streaming.older.has(snapshot.answer.id)) return;
        if (snapshot.answer.id === streaming.id) {
          clearTimeout(streaming.timer);
          streaming = null;
          publishedId = snapshot.answer.id;
          latestTime = snapshot.answer.updatedAt;
          markFinal(snapshot.answer.id, snapshot.answer);
          offline = false;
        }
      }
      if (snapshot.answer && snapshot.answer.updatedAt < latestTime) return;
      if (snapshot.answer && (snapshot.answer.id !== lastAnswerId || offline)) {
        if (streaming) clearTimeout(streaming.timer);
        streaming = null;
        lastAnswerId = publishedId = snapshot.answer.id;
        latestTime = snapshot.answer.updatedAt;
        setPlayback({ answer: snapshot.answer, key: ++generation, final: true });
      }
      if (
        snapshot.answer &&
        acknowledged !== snapshot.answer.id &&
        !acknowledging
      ) {
        const id = snapshot.answer.id;
        acknowledging = true;
        void post("/api/viewer/ack", { questionId: id })
          .then(() => {
            acknowledged = id;
          })
          .catch(() => {
            /* Retry without replay on the next snapshot. */
          })
          .finally(() => {
            acknowledging = false;
          });
      }
      offline = false;
    };
    const failed = (error: unknown) => {
      if (disposed || stopped) return;
      if (
        error instanceof ClientError &&
        ["UNAUTHORIZED", "SESSION_ENDED"].includes(error.code)
      )
        finish();
      else {
        offline = true;
        setConnected(false);
      }
    };
    const read = async (heartbeat = false) => {
      if (disposed || stopped || !navigator.onLine) return;
      const epoch = networkEpoch;
      try {
        const snapshot = heartbeat
          ? await post<ViewerSnapshot>("/api/session/viewer")
          : await api<ViewerSnapshot>("/api/session/viewer");
        if (epoch === networkEpoch) apply(snapshot);
      } catch (error) {
        if (epoch === networkEpoch) failed(error);
      }
    };
    const connect = async () => {
      source?.close();
      await read(true);
      if (disposed || stopped || !navigator.onLine) return;
      source = new EventSource("/api/viewer/events");
      source.onopen = () => {
        streamOpen = true;
      };
      source.onerror = () => {
        streamOpen = false;
        offline = true;
        setConnected(false);
        void read();
      };
      source.addEventListener("snapshot", (event) => {
        try {
          apply(JSON.parse((event as MessageEvent).data));
        } catch {
          streamOpen = false;
        }
      });
      source.addEventListener("stream", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data);
          if (typeof data?.id === "string" && typeof data?.text === "string")
            streamText(data.id, data.text);
        } catch {
          /* Ignore a malformed push; the published answer still arrives. */
        }
      });
      source.addEventListener("stream_end", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data);
          if (typeof data?.id === "string") endStream(data.id, true);
        } catch {
          /* The 30-second safety timer still ends the stream. */
        }
      });
      source.addEventListener("ended", finish);
      source.addEventListener("connection", () => {
        streamOpen = false;
      });
    };
    const disconnected = () => {
      networkEpoch++;
      offline = true;
      streamOpen = false;
      setConnected(false);
      source?.close();
    };
    const reconnected = () => {
      networkEpoch++;
      void connect();
    };
    window.addEventListener("offline", disconnected);
    window.addEventListener("online", reconnected);
    void connect();
    const heartbeat = setInterval(() => void read(true), 15_000);
    const fallback = setInterval(() => {
      if (!streamOpen) void read();
    }, 2000);
    return () => {
      disposed = true;
      if (streaming) clearTimeout(streaming.timer);
      clearInterval(heartbeat);
      clearInterval(fallback);
      source?.close();
      window.removeEventListener("offline", disconnected);
      window.removeEventListener("online", reconnected);
    };
  }, [ended]);
  useEffect(() => {
    const changed = () =>
      setFullscreen(document.fullscreenElement === display.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  async function quit() {
    try {
      await post("/api/session/quit", { role: "viewer" });
      setEnded(true);
      setConnected(false);
      setPlayback(null);
    } catch {
      setNotice("Could not confirm quitting. Please try again.");
    }
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await display.current?.requestFullscreen();
    } catch {
      setNotice(
        "Fullscreen is unavailable in this browser. The display still works in the page.",
      );
    }
  }
  return (
    <div ref={display} className="bg-background p-1 fullscreen:p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <span className="status-badge">
          {ended
            ? "Session ended or unavailable"
            : connected
              ? "Connected"
              : "Reconnecting…"}
        </span>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={toggleFullscreen}
            className="button border-line"
          >
            {fullscreen ? "Exit fullscreen" : "Fullscreen"}
          </button>
          {!ended && (
            <button onClick={quit} className="button border-line">
              Quit session
            </button>
          )}
        </div>
      </div>
      <section
        aria-label="Live answer display"
        className="relative flex min-h-[340px] items-center overflow-hidden rounded-2xl border border-line bg-[#06090e] sm:min-h-[420px]"
        data-testid="answer-display"
      >
        {playback && !ended && (
          <>
            {marked && (
              <span
                className={`absolute top-4 left-4 rounded-full border px-3 py-1 text-xs font-semibold ${
                  marked.source === "web"
                    ? "border-amber-300/40 bg-amber-300/10 text-amber-200"
                    : "border-sky-300/40 bg-sky-300/10 text-sky-200"
                }`}
                data-testid={marked.source === "web" ? "web-answer-badge" : "made-up-answer-badge"}
              >
                {badge}
              </span>
            )}
            <AnswerTicker
              text={shownText}
              playbackKey={playback.key}
              speed={speed}
              final={playback.final}
              marked={marked}
              onComplete={() => setPlayback(null)}
            />
          </>
        )}
      </section>
      <div className="panel mt-6">
        <div className="flex items-center justify-between">
          <label htmlFor="scroll-speed" className="field-label">
            Scrolling speed
          </label>
          <output
            htmlFor="scroll-speed"
            className="font-mono text-sm text-teal-200"
          >
            {speed} px/s
          </output>
        </div>
        <input
          id="scroll-speed"
          type="range"
          min={40}
          max={400}
          step={10}
          value={speed}
          onChange={(event) => changeSpeed(Number(event.target.value))}
          aria-valuetext={`${speed} pixels per second`}
          className="mt-3 min-h-11 w-full"
        />
        <p className="control-note">
          Each answer scrolls once, then the display clears. New answers replace
          the current one. Reconnecting restores the latest available answer.
        </p>
      </div>
      {notice && (
        <p role="status" className="mt-4 text-sm text-muted">
          {notice}
        </p>
      )}
      {ended && (
        <Link href="/" className="preview-link text-teal-300">
          Return home to join a session
        </Link>
      )}
    </div>
  );
}

"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ClientError, post } from "@/lib/client-api";
import type { GlobalSessionAvailability } from "@/types/session";
type Configuration = {
  model: string;
  fallbackModel: string | null;
  configured: boolean;
};
export function AdminWorkspace() {
  const [authenticated, setAuthenticated] = useState(false),
    [checking, setChecking] = useState(true),
    [password, setPassword] = useState("");
  const [configuration, setConfiguration] = useState<Configuration | null>(
    null,
  );
  const [memory, setMemory] = useState(""),
    [savedMemory, setSavedMemory] = useState<string | null>(null),
    [memoryLimit, setMemoryLimit] = useState(100_000);
  const [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [live, setLive] = useState<GlobalSessionAvailability | null>(null);
  const loadLive = useCallback(async () => {
    try {
      setLive(
        await api<GlobalSessionAvailability>("/api/session/availability"),
      );
    } catch {
      setLive(null);
    }
  }, []);
  const failed = useCallback((error: unknown) => {
    if (
      error instanceof ClientError &&
      ["ADMIN_REQUIRED", "ADMIN_NOT_CONFIGURED"].includes(error.code)
    )
      setAuthenticated(false);
    setNotice(
      error instanceof Error
        ? error.message
        : "The request failed. Please retry.",
    );
  }, []);
  useEffect(() => {
    let disposed = false;
    api<{ ai: Configuration }>("/api/admin/session")
      .then((result) => {
        if (!disposed) {
          setAuthenticated(true);
          setConfiguration(result.ai);
        }
      })
      .catch((error) => {
        if (
          !disposed &&
          !(error instanceof ClientError && error.code === "ADMIN_REQUIRED")
        )
          failed(error);
      })
      .finally(() => {
        if (!disposed) setChecking(false);
      });
    return () => {
      disposed = true;
    };
  }, [failed]);
  useEffect(() => {
    if (!authenticated) return;
    const initial = setTimeout(() => void loadLive(), 0);
    const poll = setInterval(() => void loadLive(), 5000);
    return () => {
      clearTimeout(initial);
      clearInterval(poll);
    };
  }, [authenticated, loadLive]);
  useEffect(() => {
    if (!authenticated) return;
    let disposed = false;
    api<{ memory: string; maxCharacters: number }>("/api/admin/memory")
      .then((result) => {
        if (disposed) return;
        setMemory(result.memory);
        setSavedMemory(result.memory);
        setMemoryLimit(result.maxCharacters);
      })
      .catch((error) => {
        if (!disposed) failed(error);
      });
    return () => {
      disposed = true;
    };
  }, [authenticated, failed]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await work();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  }
  async function saveMemory(event: FormEvent) {
    event.preventDefault();
    await action(async () => {
      const value = memory;
      const result = await api<{ characters: number }>("/api/admin/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memory: value }),
      });
      setSavedMemory(value);
      setNotice(
        `Memory saved (${result.characters.toLocaleString()} characters). It is used for the next question.`,
      );
    });
  }
  async function endLiveSession() {
    if (
      !window.confirm(
        "End the current session now for both participants? Their pages will show that the session has ended.",
      )
    )
      return;
    await action(async () => {
      try {
        const result = await api<{ ended: boolean }>(
          "/api/admin/live-session",
          { method: "DELETE" },
        );
        setNotice(
          result.ended
            ? "The session was ended. A new session can be created now."
            : "There was no open session to end.",
        );
      } catch (error) {
        // A lost reply can hide a successful end: report only if still open.
        const stillOpen = await api<GlobalSessionAvailability>(
          "/api/session/availability",
        )
          .then((result) => result.available === false)
          .catch(() => true);
        if (stillOpen) throw error;
        setNotice("The session was ended. A new session can be created now.");
      } finally {
        await loadLive();
      }
    });
  }
  const liveStatus = !live
    ? "Checking…"
    : live.available
      ? "No open session"
      : live.senderQuit
        ? "Open — the sender has quit"
        : live.viewerQuit
          ? "Open — the viewer has quit"
          : live.viewerOccupied
            ? "Open — sender and viewer joined"
            : "Open — waiting for the viewer";
  if (checking)
    return <p className="text-muted">Checking administrator access…</p>;
  if (!authenticated)
    return (
      <section className="panel max-w-lg">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              const result = await post<{ ai: Configuration }>(
                "/api/admin/session",
                { password },
              );
              setPassword("");
              setConfiguration(result.ai);
              setAuthenticated(true);
            });
          }}
        >
          <label className="field-label" htmlFor="admin-password">
            Administrator password
          </label>
          <input
            id="admin-password"
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            className="text-input mt-3"
          />
          <button className="button button-sender mt-5" disabled={busy}>
            Sign in
          </button>
        </form>
        {notice && (
          <p role="alert" className="mt-4 text-sm text-rose-300">
            {notice}
          </p>
        )}
      </section>
    );
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">Memory management</p>
        <button
          className="button border-line"
          disabled={busy}
          onClick={() =>
            action(async () => {
              await api("/api/admin/session", { method: "DELETE" });
              setAuthenticated(false);
              setMemory("");
              setSavedMemory(null);
            })
          }
        >
          Sign out
        </button>
      </div>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <section className="panel" data-testid="live-session-panel">
        <h2 className="font-semibold">Current session</h2>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted" aria-live="polite">
            {liveStatus}
          </p>
          <button
            type="button"
            disabled={busy || !live || live.available}
            onClick={() => void endLiveSession()}
            className="button border-line text-rose-300"
          >
            End session now
          </button>
        </div>
      </section>
      <section className="panel">
        <form onSubmit={saveMemory}>
          <label htmlFor="memory" className="font-semibold">
            Memory
          </label>
          <p className="control-note mt-2">
            Write everything the answers may use: your background, course,
            university, finances, accommodation and plans. Answers are given
            in the first person for a pre-CAS interview, using only this text.
            A question this text does not cover is answered &ldquo;Not in
            memory&rdquo;.
          </p>
          <textarea
            id="memory"
            rows={24}
            maxLength={memoryLimit}
            value={memory}
            disabled={savedMemory === null}
            onChange={(event) => setMemory(event.target.value)}
            className="text-input mt-4 leading-6"
            placeholder={
              savedMemory === null ? "Loading memory…" : "Write your memory here."
            }
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <span className="control-note" aria-live="polite">
              {memory.length.toLocaleString()} /{" "}
              {memoryLimit.toLocaleString()} characters ·{" "}
              {savedMemory === null
                ? "Loading"
                : memory === savedMemory
                  ? "Saved"
                  : "Unsaved changes"}
            </span>
            <button
              disabled={busy || savedMemory === null || memory === savedMemory}
              className="button button-sender"
            >
              Save memory
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2 className="mb-4 font-semibold">AI configuration</h2>
        <p className="text-sm text-muted">
          Gemini:{" "}
          {configuration?.configured
            ? "Key configured; usage depends on provider quota"
            : "Key not configured"}
          . Model: <code>{configuration?.model}</code>
          {configuration?.fallbackModel && (
            <>
              , backup <code>{configuration.fallbackModel}</code>
            </>
          )}
          .
        </p>
        <p className="control-note mt-2">
          Change model settings in the server environment.
        </p>
      </section>
    </div>
  );
}

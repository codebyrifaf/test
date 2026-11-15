"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, post } from "@/lib/client-api";
import type { GlobalSessionAvailability } from "@/types/session";
import { useSessionAvailability } from "@/lib/use-session-availability";
import { Icon } from "./icon";

export function HomeWorkspace() {
  const router = useRouter();
  const {
    availability,
    checking,
    error: availabilityError,
    refresh,
  } = useSessionAvailability();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ownsSender = availability?.ownedRoles.includes("sender") === true;
  const ownsViewer = availability?.ownedRoles.includes("viewer") === true;
  const canJoin =
    availability?.available === false &&
    !availability.viewerOccupied &&
    !availability.senderQuit &&
    !ownsSender &&
    !ownsViewer;
  const showInitialCards = availability?.available === true;
  const status = !availability
    ? checking
      ? "Checking session availability…"
      : "Session availability unavailable"
    : availability.available
      ? "No active session"
      : availability.senderQuit
        ? "Sender has quit — this session can no longer be used"
        : availability.viewerQuit
          ? "Viewer has quit — this session can no longer be used"
          : availability.viewerOccupied
            ? "Session in progress — both roles are occupied"
            : "Sender active — waiting for viewer";

  const halfClosed =
    availability?.available === false &&
    (availability.senderQuit || availability.viewerQuit);
  async function endSession() {
    if (
      busy ||
      !window.confirm(
        "End this session now for both participants? A new session can then be created.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await post("/api/session/end");
    } catch (error) {
      // The end may have been applied even if its reply was lost: only report
      // a failure when the session is verifiably still open.
      const stillOpen = await api<GlobalSessionAvailability>(
        "/api/session/availability",
      )
        .then((result) => result.available === false)
        .catch(() => true);
      if (stillOpen)
        setError(
          error instanceof Error ? error.message : "Could not end the session.",
        );
    }
    await refresh();
    setBusy(false);
  }
  async function connect(role: "sender" | "viewer") {
    if (
      busy ||
      (role === "sender" ? checking || !availability?.available : !canJoin)
    )
      return;
    setBusy(true);
    setError("");
    try {
      await post(
        `/api/session/${role === "sender" ? "create" : "join"}`,
        role === "viewer" ? { code } : {},
      );
      router.push(`/${role}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Connection failed.");
      await refresh();
      setBusy(false);
    }
  }
  return (
    <>
      <div className="notice mb-7">
        <Icon name="connection" />
        <p role="status" aria-live="polite" data-testid="global-session-status">
          {status}
        </p>
      </div>
      {(error || availabilityError) && (
        <p role="alert" className="mb-5 text-sm text-rose-300">
          {error || availabilityError}
        </p>
      )}
      {halfClosed && (
        <section className="panel mb-5" data-testid="end-session-card">
          <h2 className="font-semibold">End this session</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {availability.senderQuit ? "The sender" : "The viewer"} has quit,
            and a role cannot be rejoined, so this session cannot continue. End
            it now to create a new session. The other participant&rsquo;s page
            will show that the session has ended.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void endSession()}
            className="button border-line mt-4"
          >
            {busy ? "Ending…" : "End session now"}
          </button>
        </section>
      )}
      <div className="grid gap-5 xl:grid-cols-2">
        {showInitialCards && (
          <section
            className="role-card role-sender"
            data-testid="create-sender-card"
          >
            <div className="flex items-center justify-between">
              <Icon name="send" className="size-7 text-violet-300" />
              <span className="role-label text-violet-300">
                Person A · Sender
              </span>
            </div>
            <h2 className="mt-6 text-2xl font-semibold">
              Create Sender Session
            </h2>
            <p className="mt-3 text-sm leading-7 text-muted">
              Ask questions continuously and follow their delivery status.
              Answers appear only in the viewer workspace.
            </p>
            <button
              type="button"
              disabled={busy || checking}
              onClick={() => connect("sender")}
              className="button button-sender mt-7 w-full"
            >
              {busy ? "Connecting…" : "Create Session"}
            </button>
          </section>
        )}
        {ownsSender && (
          <section
            className="role-card role-sender"
            data-testid="sender-owner-card"
          >
            <div className="flex items-center justify-between">
              <Icon name="send" className="size-7 text-violet-300" />
              <span className="role-label text-violet-300">
                Person A · Sender
              </span>
            </div>
            <h2 className="mt-6 text-2xl font-semibold">Sender Active</h2>
            <p className="mt-3 text-sm leading-7 text-muted">
              This browser owns the sender role in the current session.
            </p>
            <Link href="/sender" className="button button-sender mt-7 w-full">
              Return to sender workspace
            </Link>
          </section>
        )}
        {ownsViewer && (
          <section
            className="role-card role-viewer"
            data-testid="viewer-owner-card"
          >
            <div className="flex items-center justify-between">
              <Icon name="display" className="size-7 text-teal-300" />
              <span className="role-label text-teal-300">
                Person B · Viewer
              </span>
            </div>
            <h2 className="mt-6 text-2xl font-semibold">Viewer Active</h2>
            <p className="mt-3 text-sm leading-7 text-muted">
              This browser owns the viewer role in the current session.
            </p>
            <Link href="/viewer" className="button button-viewer mt-7 w-full">
              Return to viewer workspace
            </Link>
          </section>
        )}
        {(showInitialCards || canJoin) && (
          <section
            className="role-card role-viewer"
            data-testid="join-viewer-card"
          >
            <div className="flex items-center justify-between">
              <Icon name="display" className="size-7 text-teal-300" />
              <span className="role-label text-teal-300">
                Person B · Viewer
              </span>
            </div>
            <h2 className="mt-6 text-2xl font-semibold">Join as Viewer</h2>
            <p className="mt-3 text-sm leading-7 text-muted">
              {canJoin
                ? "Sender active — enter your session code to join."
                : "No session is available yet. Wait for Person A to create one."}
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void connect("viewer");
              }}
            >
              <label htmlFor="session-code" className="field-label mt-5">
                Private session code
              </label>
              <input
                id="session-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                maxLength={128}
                required
                disabled={!canJoin || busy}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="text-input mt-2 font-mono"
              />
              <button
                disabled={busy || !canJoin || !code.trim()}
                className="button button-viewer mt-5 w-full"
              >
                Join Session
              </button>
            </form>
          </section>
        )}
      </div>
      <p className="mt-6 text-xs leading-6 text-muted">
        Keep your original browser cookies to reconnect. Each session has one
        sender and one viewer. It closes immediately when both participants
        quit; after one quits, anyone can end it here. Inactive sessions expire
        automatically, and the administrator can end any session.
      </p>
    </>
  );
}

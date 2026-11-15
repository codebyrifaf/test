"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client-api";
import type { GlobalSessionAvailability } from "@/types/session";

export function useSessionAvailability() {
  const [availability, setAvailability] =
    useState<GlobalSessionAvailability | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const refresh = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let disposed = false;
    let version = 0;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const current = ++version;
      clearTimeout(timer);
      controller?.abort();
      controller = new AbortController();
      setChecking(true);
      try {
        const result = await api<GlobalSessionAvailability>(
          "/api/session/availability",
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(8000),
            ]),
          },
        );
        if (disposed || current !== version) return;
        if (!(
          (result?.available === true && result.status === "none") ||
          (result?.available === false &&
            ["waiting", "active"].includes(result.status))
        )) {
          throw new Error("Could not verify session availability. Retrying…");
        }
        if (
          !Array.isArray(result.ownedRoles) ||
          result.ownedRoles.some(
            (role) => role !== "sender" && role !== "viewer",
          ) ||
          [
            result.senderOccupied,
            result.viewerOccupied,
            result.senderQuit,
            result.viewerQuit,
          ].some((value) => typeof value !== "boolean")
        ) {
          throw new Error("Could not verify session roles. Retrying…");
        }
        setAvailability(result);
        setError("");
      } catch (error) {
        if (disposed || current !== version) return;
        // Fail closed; never leave a stale 'available' response enabled.
        setAvailability(null);
        setError(
          error instanceof Error
            ? error.message
            : "Could not verify session availability. Retrying…",
        );
      } finally {
        if (!disposed && current === version) {
          setChecking(false);
          timer = setTimeout(() => void check(), 2000);
        }
      }
    };
    const refreshNow = () => {
      void check();
    };
    const visible = () => {
      if (!document.hidden) refreshNow();
    };
    const offline = () => {
      version++;
      controller?.abort();
      clearTimeout(timer);
      setAvailability(null);
      setChecking(false);
      setError(
        "Connection interrupted. Session availability will refresh when you reconnect.",
      );
    };
    refresh.current = check;
    void check();
    window.addEventListener("focus", refreshNow);
    window.addEventListener("online", refreshNow);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      version++;
      clearTimeout(timer);
      controller?.abort();
      refresh.current = async () => {};
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("online", refreshNow);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  return { availability, checking, error, refresh: () => refresh.current() };
}

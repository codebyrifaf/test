import "server-only";

/**
 * In-process push from the answer worker to viewer streams in the same server
 * process. Only a speed optimization: the database remains authoritative, and
 * viewers still receive published answers by polling when no push arrives.
 */
export type LiveEvent =
  | { type: "stream"; id: string; text: string }
  | { type: "published"; id: string }
  | { type: "stream_end"; id: string };
type Listener = (event: LiveEvent) => void;

const channels = ((globalThis as { __relayLive?: Map<string, Set<Listener>> })
  .__relayLive ??= new Map());

export function publishLive(sessionId: string, event: LiveEvent) {
  for (const listener of channels.get(sessionId) ?? []) {
    try {
      listener(event);
    } catch {
      /* A closed stream must not affect the worker or other viewers. */
    }
  }
}

export function subscribeLive(sessionId: string, listener: Listener) {
  let listeners = channels.get(sessionId);
  if (!listeners) channels.set(sessionId, (listeners = new Set()));
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && channels.get(sessionId) === listeners)
      channels.delete(sessionId);
  };
}

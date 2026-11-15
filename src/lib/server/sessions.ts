import "server-only";
import type {
  ParticipantRole,
  SenderSnapshot,
  ViewerSnapshot,
  SessionBase,
  QuestionStatus,
} from "@/types/session";
import { rpc } from "./database";
import { AppError } from "./errors";
import { record, text } from "./validation";

// Sender credential hash → session, remembered only after the database has
// authorized it. Lets a question start AI work without waiting for that check
// again; the database still authorizes the submission itself.
const SENDER_TTL_MS = 30_000;
const senders = ((
  globalThis as {
    __relaySenders?: Map<string, { sessionId: string; expires: number }>;
  }
).__relaySenders ??= new Map());
export function recentlyAuthorizedSender(token: string): string | null {
  const entry = senders.get(token);
  if (!entry || entry.expires <= Date.now()) {
    senders.delete(token);
    return null;
  }
  return entry.sessionId;
}
export function forgetSender(token: string) {
  senders.delete(token);
}
/** After a forced end: no cached sender may start AI work for this session. */
export function forgetSession(sessionId: string) {
  for (const [token, entry] of senders)
    if (entry.sessionId === sessionId) senders.delete(token);
}

export async function getSessionSnapshot(
  role: "sender",
  token: string,
  heartbeat?: boolean,
): Promise<SenderSnapshot>;
export async function getSessionSnapshot(
  role: "viewer",
  token: string,
  heartbeat?: boolean,
): Promise<ViewerSnapshot>;
export async function getSessionSnapshot(
  role: ParticipantRole,
  token: string,
  heartbeat = false,
): Promise<SenderSnapshot | ViewerSnapshot> {
  let response: unknown;
  try {
    response = await rpc("relay_session_snapshot", {
      p_token_hash: token,
      p_role: role,
      p_heartbeat: heartbeat,
    });
  } catch (error) {
    if (
      role === "sender" &&
      error instanceof AppError &&
      [401, 410].includes(error.status)
    )
      forgetSender(token);
    throw error;
  }
  const raw = record(response);
  const base: SessionBase = {
    sessionId: text(raw.sessionId, 36),
    status: raw.status === "active" ? "active" : "waiting",
    senderConnected: raw.senderConnected === true,
    viewerConnected: raw.viewerConnected === true,
  };
  // Whitelist projection provides an additional boundary above the database RPC.
  if (role === "sender") {
    senders.set(token, {
      sessionId: base.sessionId,
      expires: Date.now() + SENDER_TTL_MS,
    });
    const q = raw.question ? record(raw.question) : null;
    return {
      ...base,
      role,
      sessionCode: text(raw.sessionCode, 128),
      question: q
        ? {
            id: text(q.id, 36),
            sequence: Number(q.sequence),
            status: text(q.status, 32) as QuestionStatus,
            errorCode: typeof q.errorCode === "string" ? q.errorCode : null,
            delivered: q.delivered === true,
          }
        : null,
    };
  }
  const answer = raw.answer ? record(raw.answer) : null;
  return {
    ...base,
    role,
    answer: answer
      ? {
          id: text(answer.id, 36),
          text: typeof answer.text === "string" ? answer.text : "",
          updatedAt: text(answer.updatedAt, 64),
        }
      : null,
  };
}

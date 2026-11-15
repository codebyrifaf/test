import "server-only";
import { database, rpc } from "./database";
import { AppError, databaseError } from "./errors";
import { forgetSession } from "./sessions";

/**
 * Ends the live session for both participants immediately.
 * - `onlyIfQuit`: refuse unless a participant has already quit. A session in
 *   that state can never be used again (a quit role cannot rejoin), so ending
 *   it needs no credential.
 * Termination deletes the temporary answer (database trigger); both
 * participants then receive "session ended" on their next request.
 */
export async function endLiveSession({
  onlyIfQuit,
}: {
  onlyIfQuit: boolean;
}): Promise<boolean> {
  // Apply any pending expiry first (best effort; ending must not depend on it).
  await rpc("relay_session_availability", {}).catch(() => undefined);
  const { data: session, error } = await database()
    .from("sessions")
    .select("id,created_at")
    .neq("status", "terminated")
    .maybeSingle();
  if (error) throw databaseError(error);
  if (!session) return false;
  if (onlyIfQuit) {
    const quit = await database()
      .from("session_participants")
      .select("id")
      .eq("session_id", session.id)
      .eq("explicitly_quit", true)
      .limit(1);
    if (quit.error) throw databaseError(quit.error);
    // A quit is permanent, so this check cannot be invalidated by a race.
    if (!quit.data.length) throw new AppError("SESSION_IN_USE", 409);
  }
  // terminated_at must not precede created_at, even with clock differences.
  const terminatedAt = new Date(
    Math.max(Date.now(), Date.parse(session.created_at)),
  ).toISOString();
  // The update only affects a still-open session, so retrying is safe. If a
  // reply is lost after the database applied it, the session is already ended.
  let failure: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ended = await database()
      .from("sessions")
      .update({ status: "terminated", terminated_at: terminatedAt })
      .eq("id", session.id)
      .neq("status", "terminated")
      .select("id");
    if (!ended.error) {
      forgetSession(session.id);
      if (ended.data.length) return true;
      return await isTerminated(session.id);
    }
    failure = databaseError(ended.error);
    if (await isTerminated(session.id).catch(() => false)) {
      forgetSession(session.id);
      return true;
    }
  }
  throw failure;
}

async function isTerminated(sessionId: string) {
  const { data, error } = await database()
    .from("sessions")
    .select("status")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw databaseError(error);
  return !data || data.status === "terminated";
}

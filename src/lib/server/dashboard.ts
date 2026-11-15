import "server-only";
import type {
  GlobalSessionAvailability,
  ParticipantRole,
} from "@/types/session";
import { database, rpc } from "./database";
import { AppError, databaseError } from "./errors";
import { participantHash } from "./security";

async function authorizedHash(role: ParticipantRole): Promise<string | null> {
  try {
    return await participantHash(role);
  } catch (error) {
    if (error instanceof AppError && error.code === "UNAUTHORIZED") return null;
    throw error;
  }
}

export async function getDashboardAvailability(
  readHash: (role: ParticipantRole) => Promise<string | null> = authorizedHash,
): Promise<GlobalSessionAvailability> {
  await rpc("relay_session_availability", {});
  const { data: session, error } = await database()
    .from("sessions")
    .select("id,status")
    .neq("status", "terminated")
    .maybeSingle();
  if (error) throw databaseError(error);
  if (!session)
    return {
      available: true,
      status: "none",
      senderOccupied: false,
      viewerOccupied: false,
      senderQuit: false,
      viewerQuit: false,
      ownedRoles: [],
    };

  const participants = await database()
    .from("session_participants")
    .select(
      "role,explicitly_quit,reconnect_token_hash,token_revoked_at,token_expires_at",
    )
    .eq("session_id", session.id);
  if (participants.error) throw databaseError(participants.error);
  const sender = participants.data.find((row) => row.role === "sender");
  const viewer = participants.data.find((row) => row.role === "viewer");
  // No cached/browser claim can make a missing or invalid database slot available.
  if (!sender) throw new AppError("DATABASE_UNAVAILABLE", 503);
  const ownedRoles: ParticipantRole[] = [];
  for (const participant of participants.data) {
    if (
      participant.explicitly_quit ||
      participant.token_revoked_at ||
      (participant.token_expires_at !== null &&
        !(Date.parse(participant.token_expires_at) > Date.now()))
    )
      continue;
    const hash = await readHash(participant.role);
    if (hash && hash === participant.reconnect_token_hash)
      ownedRoles.push(participant.role);
  }
  // Explicit allowlist: no IDs, codes, hashes, credentials or answer data leave this helper.
  return {
    available: false,
    status: viewer ? "active" : "waiting",
    senderOccupied: true,
    viewerOccupied: Boolean(viewer),
    senderQuit: sender.explicitly_quit,
    viewerQuit: viewer?.explicitly_quit ?? false,
    ownedRoles,
  };
}

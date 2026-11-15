import { rpc } from "@/lib/server/database";
import { AppError, apiError, jsonResponse } from "@/lib/server/errors";
import { clearParticipantCookie, participantHash } from "@/lib/server/security";
import { forgetSender } from "@/lib/server/sessions";
import { jsonBody, sameOrigin } from "@/lib/server/validation";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = await jsonBody(request, 1024);
    if (body.role !== "sender" && body.role !== "viewer")
      throw new AppError("INVALID_INPUT");
    const token = await participantHash(body.role);
    const result = await rpc("relay_quit_session", {
      p_role: body.role,
      p_token_hash: token,
    });
    if (body.role === "sender") forgetSender(token);
    await clearParticipantCookie(body.role);
    return jsonResponse(result);
  } catch (error) {
    return apiError(error);
  }
}

import { rpc } from "@/lib/server/database";
import { apiError, jsonResponse } from "@/lib/server/errors";
import {
  digest,
  newCredential,
  rateLimit,
  requestScope,
  sessionCode,
  setParticipantCookie,
} from "@/lib/server/security";
import { sameOrigin } from "@/lib/server/validation";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    await rateLimit(requestScope(request, "create"), 5);
    const credential = newCredential();
    const result = await rpc("relay_create_session", {
      p_code: sessionCode(),
      p_token_hash: digest(credential),
    });
    await setParticipantCookie("sender", credential);
    return jsonResponse(result, 201);
  } catch (error) {
    return apiError(error);
  }
}

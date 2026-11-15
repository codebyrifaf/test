import { rpc } from "@/lib/server/database";
import { apiError, jsonResponse } from "@/lib/server/errors";
import {
  digest,
  newCredential,
  rateLimit,
  requestScope,
  setParticipantCookie,
} from "@/lib/server/security";
import { jsonBody, sameOrigin, text } from "@/lib/server/validation";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    await rateLimit(requestScope(request, "join"), 15);
    const body = await jsonBody(request, 2048);
    const credential = newCredential();
    const result = await rpc("relay_join_session", {
      p_code: text(body.code, 128).trim(),
      p_token_hash: digest(credential),
    });
    await setParticipantCookie("viewer", credential);
    return jsonResponse(result);
  } catch (error) {
    return apiError(error);
  }
}

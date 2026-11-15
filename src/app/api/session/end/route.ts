import { apiError, jsonResponse } from "@/lib/server/errors";
import { rateLimit, requestScope } from "@/lib/server/security";
import { endLiveSession } from "@/lib/server/termination";
import { sameOrigin } from "@/lib/server/validation";
// Ends a session that can no longer be used because a participant has quit.
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    await rateLimit(requestScope(request, "end-session"), 10);
    return jsonResponse({ ended: await endLiveSession({ onlyIfQuit: true }) });
  } catch (error) {
    return apiError(error);
  }
}

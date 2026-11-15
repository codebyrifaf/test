import { apiError, jsonResponse } from "@/lib/server/errors";
import { requireAdmin } from "@/lib/server/security";
import { endLiveSession } from "@/lib/server/termination";
import { sameOrigin } from "@/lib/server/validation";
// Administrator override: ends the live session for both participants.
export async function DELETE(request: Request) {
  try {
    sameOrigin(request);
    await requireAdmin();
    return jsonResponse({ ended: await endLiveSession({ onlyIfQuit: false }) });
  } catch (error) {
    return apiError(error);
  }
}

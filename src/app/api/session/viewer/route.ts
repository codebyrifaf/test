import { after } from "next/server";
import { processLatestQuestion } from "@/lib/ai/worker";
import { apiError, jsonResponse } from "@/lib/server/errors";
import { participantHash } from "@/lib/server/security";
import { getSessionSnapshot } from "@/lib/server/sessions";
import { sameOrigin } from "@/lib/server/validation";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function GET() {
  try {
    return jsonResponse(
      await getSessionSnapshot("viewer", await participantHash("viewer")),
    );
  } catch (error) {
    return apiError(error);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const state = await getSessionSnapshot(
      "viewer",
      await participantHash("viewer"),
      true,
    );
    after(() => processLatestQuestion(state.sessionId));
    return jsonResponse(state);
  } catch (error) {
    return apiError(error);
  }
}

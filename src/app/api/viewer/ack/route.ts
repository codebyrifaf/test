import { rpc } from "@/lib/server/database";
import { apiError, jsonResponse } from "@/lib/server/errors";
import { participantHash } from "@/lib/server/security";
import { jsonBody, sameOrigin, uuid } from "@/lib/server/validation";
import {
  processingContext,
  processingEvent,
  processingQuestion,
  processingStage,
} from "@/lib/server/processing-diagnostics";
export async function POST(request: Request) {
  return processingContext(async () => {
    try {
      sameOrigin(request);
      const body = await jsonBody(request, 1024);
      const questionId = uuid(body.questionId);
      processingQuestion(questionId);
      const token = await participantHash("viewer");
      const acknowledged = await processingStage("acknowledgement", () =>
        rpc("relay_ack_answer", {
          p_token_hash: token,
          p_question_id: questionId,
        }),
      );
      processingEvent("viewer_ack", {
        outcome: acknowledged ? "acknowledged" : "ignored",
      });
      return jsonResponse({ acknowledged: true });
    } catch (error) {
      processingEvent("acknowledgement_failed", {}, error);
      return apiError(error);
    }
  });
}

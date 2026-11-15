import { after } from "next/server";
import { startAnswer, type AnswerRun } from "@/lib/ai/pipeline";
import { processLatestQuestion, registerPendingRun } from "@/lib/ai/worker";
import { rpc } from "@/lib/server/database";
import { apiError, AppError, jsonResponse } from "@/lib/server/errors";
import type { AnswerLength } from "@/types/session";
import { participantHash, rateLimit } from "@/lib/server/security";
import {
  getSessionSnapshot,
  recentlyAuthorizedSender,
} from "@/lib/server/sessions";
import {
  jsonBody,
  record,
  sameOrigin,
  text,
  uuid,
} from "@/lib/server/validation";
import {
  processingContext,
  processingEvent,
  processingQuestion,
  processingStage,
} from "@/lib/server/processing-diagnostics";
export const maxDuration = 120;
export async function POST(request: Request) {
  return processingContext(async () => {
    let run: AnswerRun | undefined;
    try {
      sameOrigin(request);
      const token = await participantHash("sender");
      const body = await jsonBody(request);
      const question = text(body.question, 12_000);
      const requestId = uuid(body.requestId);
      // A missing length means the shortest answer; anything else is rejected.
      const length: AnswerLength =
        body.length === undefined ? "short" : (body.length as AnswerLength);
      if (!["short", "medium", "long"].includes(length))
        throw new AppError("INVALID_INPUT");
      // Spend on AI only for a sender the database authorized moments ago;
      // otherwise authorize first. Either way the answer starts before the
      // question is saved, so database round trips overlap with generation.
      let sessionId = recentlyAuthorizedSender(token);
      if (!sessionId)
        sessionId = (await getSessionSnapshot("sender", token)).sessionId;
      run = startAnswer(question, { length });
      await rateLimit(`questions:${token}`, 60);
      const receipt = record(
        await processingStage("submission", () =>
          rpc("relay_submit_question", {
            p_token_hash: token,
            p_text: question,
            p_request_id: requestId,
          }),
        ),
      );
      const questionId = uuid(receipt.id);
      processingQuestion(questionId);
      processingEvent("accepted");
      // A repeated request ID returns an existing question; reuse nothing then.
      if (receipt.status === "queued")
        registerPendingRun(questionId, run, length);
      else run.abort(new Error("duplicate request"));
      const target = sessionId;
      after(() => processLatestQuestion(target));
      return jsonResponse(receipt, 202);
    } catch (error) {
      run?.abort(new Error("submission rejected"));
      processingEvent("submission_failed", {}, error);
      return apiError(error);
    }
  });
}

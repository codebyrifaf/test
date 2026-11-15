export type ParticipantRole = "sender" | "viewer";
/** Requested answer length on screen: 20–30 s, about 40 s, or 60–70 s. */
export type AnswerLength = "short" | "medium" | "long";
export type GlobalSessionAvailability = (
  | { available: true; status: "none" }
  | { available: false; status: "waiting" | "active" }
) & {
  senderOccupied: boolean;
  viewerOccupied: boolean;
  senderQuit: boolean;
  viewerQuit: boolean;
  ownedRoles: ParticipantRole[];
};
export type QuestionStatus =
  "queued" | "processing" | "completed" | "superseded" | "failed";
export type QuestionReceipt = {
  id: string;
  sequence: number;
  status: QuestionStatus;
};
export type SessionBase = {
  sessionId: string;
  status: "waiting" | "active";
  senderConnected: boolean;
  viewerConnected: boolean;
};
export type SenderSnapshot = SessionBase & {
  role: "sender";
  sessionCode: string;
  question:
    (QuestionReceipt & { errorCode: string | null; delivered: boolean }) | null;
};
export type LiveAnswer = { id: string; text: string; updatedAt: string };
export type ViewerSnapshot = SessionBase & {
  role: "viewer";
  answer: LiveAnswer | null;
};
export type SessionSnapshot = SenderSnapshot | ViewerSnapshot;
export type ApiFailure = { error: { code: string; message: string } };

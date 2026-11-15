import "server-only";

const messages: Record<string, string> = {
  INVALID_INPUT: "Please check the information you entered.",
  UNAUTHORIZED:
    "Your participant connection is unavailable. Return to the home page.",
  ADMIN_REQUIRED: "Administrator sign-in is required.",
  INVALID_PASSWORD: "The password was not accepted.",
  ADMIN_NOT_CONFIGURED:
    "Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET on the server first.",
  SESSION_BUSY:
    "Another session is already open. Reconnect to your existing session or wait for it to close.",
  SESSION_ENDED:
    "This session has ended. Return home to create or join a new session.",
  INVALID_CODE: "No open session matches that code.",
  VIEWER_TAKEN:
    "This session already has a viewer. Reconnect using the original browser.",
  RATE_LIMITED:
    "Too many requests in a short period. Please try again shortly.",
  SETUP_REQUIRED:
    "The application database migration or server configuration is not ready.",
  DATABASE_UNAVAILABLE:
    "The database could not complete this request. Please try again.",
  FORBIDDEN_ORIGIN: "This request must come from the application itself.",
  PAYLOAD_TOO_LARGE: "The submitted content exceeds the allowed request size.",
  DUPLICATE_QUESTION:
    "This question or an alternative phrasing already exists in the knowledge base.",
  FILE_UNSUPPORTED: "Use a PDF, DOCX, XLSX, CSV, or TXT file.",
  FILE_INVALID:
    "The file does not match its type, is encrypted, or could not be read safely.",
  EXTRACTION_FAILED:
    "No readable text could be extracted. Scanned images require OCR before upload.",
  STORAGE_UNAVAILABLE:
    "The private document storage operation failed. Please try again.",
  NOT_FOUND: "The requested record was not found.",
  SESSION_IN_USE:
    "Both participants are still in this session. It can only be ended here after one of them quits.",
};

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
    public readonly databaseCode?: string,
  ) {
    super(messages[code] ?? "The request could not be completed.");
    this.name = "AppError";
  }
}

export function databaseError(error: {
  code?: string;
  message?: string;
}): AppError {
  const name = error.message?.match(/^RELAY_([A-Z_]+)/)?.[1];
  if (name && messages[name])
    return new AppError(
      name,
      name === "UNAUTHORIZED" ? 401 : name === "SESSION_ENDED" ? 410 : 409,
      error.code,
    );
  if (error.code === "23505")
    return new AppError("DUPLICATE_QUESTION", 409, error.code);
  if (["PGRST202", "PGRST205", "42P01", "42703"].includes(error.code ?? ""))
    return new AppError("SETUP_REQUIRED", 503, error.code);
  return new AppError("DATABASE_UNAVAILABLE", 503, error.code);
}

export function apiError(error: unknown): Response {
  const safe =
    error instanceof AppError
      ? error
      : new AppError("DATABASE_UNAVAILABLE", 503);
  // Server-side diagnosis of unexpected failures: codes and error type only,
  // never request data, credentials, answers or raw database messages.
  if (safe.status >= 500)
    console.error(
      "[relay_api_error]",
      JSON.stringify({
        code: safe.code,
        ...(safe.databaseCode ? { databaseCode: safe.databaseCode } : {}),
        ...(error instanceof AppError
          ? {}
          : { unexpected: error instanceof Error ? error.name : typeof error }),
      }),
    );
  return Response.json(
    { error: { code: safe.code, message: safe.message } },
    {
      status: safe.status,
      headers: {
        "Cache-Control": "no-store",
        ...(safe.code === "RATE_LIMITED" ? { "Retry-After": "60" } : {}),
      },
    },
  );
}

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

import "server-only";
import { AppError } from "./errors";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError("INVALID_INPUT");
  return value as Record<string, unknown>;
}
export function text(value: unknown, max: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!allowEmpty && !value.trim())
  )
    throw new AppError("INVALID_INPUT");
  return value;
}
export function uuid(value: unknown): string {
  const result = text(value, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      result,
    )
  )
    throw new AppError("INVALID_INPUT");
  return result;
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  // Next can normalize request.url to its bind address (localhost/0.0.0.0).
  // Host is the actual HTTP destination; do not trust forwarded-host headers.
  const expected =
    process.env.APP_ORIGIN ||
    `${url.protocol}//${request.headers.get("host") || url.host}`;
  if (
    origin !== expected ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new AppError("FORBIDDEN_ORIGIN", 403);
}
export async function limitedBody(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > limit) throw new AppError("PAYLOAD_TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new AppError("PAYLOAD_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
export async function jsonBody(request: Request, limit = 64_000) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new AppError("INVALID_INPUT");
  const bytes = await limitedBody(request, limit);
  try {
    return record(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INVALID_INPUT");
  }
}

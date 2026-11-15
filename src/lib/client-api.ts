import type { ApiFailure } from "@/types/session";

export class ClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      cache: "no-store",
      credentials: "same-origin",
      signal: options.signal ?? AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ClientError(
      "NETWORK",
      "Connection interrupted. Please try again.",
    );
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = body as ApiFailure | null;
    throw new ClientError(
      failure?.error?.code || "REQUEST_FAILED",
      failure?.error?.message || "The request could not be completed.",
    );
  }
  return body as T;
}
export function post<T>(url: string, body: unknown = {}) {
  return api<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
export function requestId() {
  // getRandomValues also works for local two-laptop HTTP testing.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

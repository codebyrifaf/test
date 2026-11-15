import "server-only";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { cookies } from "next/headers";
import type { ParticipantRole } from "@/types/session";
import { rpc } from "./database";
import { AppError } from "./errors";

export function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function newCredential() {
  return randomBytes(32).toString("base64url");
}
export function sessionCode() {
  return randomBytes(12).toString("base64url");
}
const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
});
const participantCookie = (role: ParticipantRole) => `relay_${role}`;

export async function participantHash(role: ParticipantRole) {
  const value = (await cookies()).get(participantCookie(role))?.value;
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new AppError("UNAUTHORIZED", 401);
  return digest(value);
}
export async function setParticipantCookie(
  role: ParticipantRole,
  credential: string,
) {
  (await cookies()).set(participantCookie(role), credential, {
    ...cookieOptions(),
    maxAge: 60 * 60 * 24 * 30,
  });
}
export async function clearParticipantCookie(role: ParticipantRole) {
  (await cookies()).set(participantCookie(role), "", {
    ...cookieOptions(),
    maxAge: 0,
  });
}

function adminConfiguration() {
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!password || !secret || secret.length < 32)
    throw new AppError("ADMIN_NOT_CONFIGURED", 503);
  return { password, secret };
}
function equal(a: string, b: string) {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
export function passwordAccepted(password: string) {
  return equal(digest(password), digest(adminConfiguration().password));
}
export async function setAdminCookie() {
  const { password, secret } = adminConfiguration();
  const version = createHmac("sha256", secret).update(password).digest("hex");
  const payload = Buffer.from(
    JSON.stringify({
      exp: Date.now() + 8 * 60 * 60 * 1000,
      nonce: newCredential(),
      version,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  (await cookies()).set("relay_admin", `${payload}.${signature}`, {
    ...cookieOptions(),
    maxAge: 8 * 60 * 60,
  });
}
export async function requireAdmin() {
  const { password, secret } = adminConfiguration();
  const value = (await cookies()).get("relay_admin")?.value;
  if (!value || value.length > 1024) throw new AppError("ADMIN_REQUIRED", 401);
  const [payload, signature, extra] = value.split(".");
  if (
    !payload ||
    !signature ||
    extra ||
    !equal(
      signature,
      createHmac("sha256", secret).update(payload).digest("base64url"),
    )
  )
    throw new AppError("ADMIN_REQUIRED", 401);
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const version = createHmac("sha256", secret).update(password).digest("hex");
    if (
      typeof claims.exp !== "number" ||
      claims.exp <= Date.now() ||
      claims.version !== version
    )
      throw new Error();
  } catch {
    throw new AppError("ADMIN_REQUIRED", 401);
  }
}
export async function clearAdminCookie() {
  (await cookies()).set("relay_admin", "", { ...cookieOptions(), maxAge: 0 });
}

export async function rateLimit(scope: string, limit: number, seconds = 60) {
  if (
    !(await rpc("relay_rate_limit", {
      p_scope: scope,
      p_limit: limit,
      p_window_seconds: seconds,
    }))
  )
    throw new AppError("RATE_LIMITED", 429);
}
export function requestScope(request: Request, action: string) {
  // Only trust forwarding headers when the deployment's proxy removes spoofed values.
  const address =
    process.env.TRUST_PROXY_HEADERS === "true"
      ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        "unknown"
      : "local-or-untrusted-proxy";
  const secret =
    process.env.ADMIN_SESSION_SECRET || process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new AppError("SETUP_REQUIRED", 503);
  return `${action}:${createHmac("sha256", secret).update(address).digest("hex")}`;
}

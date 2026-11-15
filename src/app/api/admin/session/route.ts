import { aiConfiguration } from "@/lib/ai/provider";
import { apiError, AppError, jsonResponse } from "@/lib/server/errors";
import {
  clearAdminCookie,
  passwordAccepted,
  rateLimit,
  requestScope,
  requireAdmin,
  setAdminCookie,
} from "@/lib/server/security";
import { jsonBody, sameOrigin, text } from "@/lib/server/validation";
export async function GET() {
  try {
    await requireAdmin();
    return jsonResponse({ authenticated: true, ai: aiConfiguration() });
  } catch (error) {
    return apiError(error);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    await rateLimit(requestScope(request, "admin-login"), 5, 300);
    const body = await jsonBody(request, 5000);
    if (!passwordAccepted(text(body.password, 1024)))
      throw new AppError("INVALID_PASSWORD", 401);
    await setAdminCookie();
    return jsonResponse({ authenticated: true, ai: aiConfiguration() });
  } catch (error) {
    return apiError(error);
  }
}
export async function DELETE(request: Request) {
  try {
    sameOrigin(request);
    await clearAdminCookie();
    return jsonResponse({ authenticated: false });
  } catch (error) {
    return apiError(error);
  }
}

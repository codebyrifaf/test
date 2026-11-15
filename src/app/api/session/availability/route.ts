import { apiError, jsonResponse } from "@/lib/server/errors";
import { getDashboardAvailability } from "@/lib/server/dashboard";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const result = await getDashboardAvailability(
      request.headers.has("cookie") ? undefined : async () => null,
    );
    const response = jsonResponse(result);
    response.headers.set("Vary", "Cookie");
    return response;
  } catch (error) {
    return apiError(error);
  }
}

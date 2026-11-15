import {
  MAX_MEMORY_CHARACTERS,
  readMemory,
  saveMemory,
} from "@/lib/knowledge/memory";
import { apiError, jsonResponse } from "@/lib/server/errors";
import { rateLimit, requireAdmin } from "@/lib/server/security";
import { jsonBody, sameOrigin, text } from "@/lib/server/validation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await requireAdmin();
    return jsonResponse({
      memory: await readMemory(),
      maxCharacters: MAX_MEMORY_CHARACTERS,
    });
  } catch (error) {
    return apiError(error);
  }
}
export async function PUT(request: Request) {
  try {
    sameOrigin(request);
    await requireAdmin();
    await rateLimit("admin:memory", 30);
    // UTF-8 can use up to four bytes per character, plus JSON escaping.
    const body = await jsonBody(request, MAX_MEMORY_CHARACTERS * 6 + 1024);
    const memory = text(body.memory, MAX_MEMORY_CHARACTERS, true);
    await saveMemory(memory);
    return jsonResponse({ saved: true, characters: memory.length });
  } catch (error) {
    return apiError(error);
  }
}

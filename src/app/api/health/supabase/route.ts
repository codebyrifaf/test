import { checkSupabaseConnection } from "@/lib/supabase/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await checkSupabaseConnection();
  return Response.json(
    { status },
    {
      status: status === "ok" ? 200 : 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

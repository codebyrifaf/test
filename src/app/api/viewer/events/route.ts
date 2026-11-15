import { AppError, apiError } from "@/lib/server/errors";
import { subscribeLive } from "@/lib/server/live-channel";
import { participantHash } from "@/lib/server/security";
import { getSessionSnapshot } from "@/lib/server/sessions";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;
const POLL_MS = 1500;

export async function GET(request: Request) {
  try {
    const token = await participantHash("viewer");
    const initial = await getSessionSnapshot("viewer", token);
    const encoder = new TextEncoder();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (chunk: string) => {
          if (cancelled) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            cancelled = true;
          }
        };
        const send = (event: string, data: unknown) =>
          write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const stop = () => {
          if (cancelled) return;
          cancelled = true;
          clearTimeout(timer);
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* Already closed. */
          }
        };
        let previous = JSON.stringify(initial);
        send("snapshot", initial);
        let polling = false;
        let again = false;
        const poll = async () => {
          if (cancelled || request.signal.aborted) return;
          if (polling) {
            again = true;
            return;
          }
          polling = true;
          clearTimeout(timer);
          try {
            const snapshot = await getSessionSnapshot("viewer", token);
            const serialized = JSON.stringify(snapshot);
            if (serialized !== previous) {
              send("snapshot", snapshot);
              previous = serialized;
            } else write(": heartbeat\n\n");
          } catch (error) {
            if (
              error instanceof AppError &&
              [401, 410].includes(error.status)
            ) {
              send("ended", { ended: true });
              stop();
              return;
            }
            send("connection", { reconnecting: true });
          } finally {
            polling = false;
          }
          if (again) {
            again = false;
            void poll();
          } else if (!cancelled) timer = setTimeout(poll, POLL_MS);
        };
        timer = setTimeout(poll, POLL_MS);
        // Same-process push: answer text as it is generated, and an immediate
        // database read the moment an answer is published.
        unsubscribe = subscribeLive(initial.sessionId, (event) => {
          if (event.type === "stream")
            send("stream", { id: event.id, text: event.text });
          else if (event.type === "stream_end")
            send("stream_end", { id: event.id });
          else void poll();
        });
        request.signal.addEventListener("abort", stop, { once: true });
      },
      cancel() {
        cancelled = true;
        clearTimeout(timer);
        unsubscribe();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

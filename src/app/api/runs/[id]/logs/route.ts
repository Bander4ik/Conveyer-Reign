import { getLogsTail, subscribe } from "@/lib/logger";
import { ensureInit } from "@/lib/init";

/**
 * Initial history window for a run-page load. Past this many entries the
 * browser starts choking on DOM rendering and JSON parsing — on a 1 000+ scene
 * video the full log can easily be 10 000+ rows. The live SSE keeps appending
 * after this initial flush, so live activity is still visible immediately.
 * Older entries are still in `run_logs` — open the DB or run folder to inspect.
 */
const INITIAL_HISTORY_LIMIT = 500;

/**
 * SSE stream of logs for a specific run.
 * First flushes the recent history window, then subscribes to live events.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(enc.encode(`event: ${event}\n`));
        controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // 1. history — capped to the recent window to keep the page responsive
      for (const log of getLogsTail(id, INITIAL_HISTORY_LIMIT)) send("log", log);
      send("ready", { runId: id });

      // 2. live
      const unsub = subscribe(id, (e) => send("log", e));

      // 3. heartbeat so proxies don't kill the connection
      const ping = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`: ping\n\n`));
        } catch {}
      }, 15000);

      const close = () => {
        clearInterval(ping);
        unsub();
        try {
          controller.close();
        } catch {}
      };
      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

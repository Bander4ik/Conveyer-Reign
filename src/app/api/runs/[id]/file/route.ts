import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { getRunDir } from "@/lib/run-paths";

const getRun = db.prepare("SELECT id FROM runs WHERE id = ?");

/**
 * Serves any file from a run folder.
 *   /api/runs/{id}/file?p=final.mp4
 *   /api/runs/{id}/file?p=audio/scene_000.mp3
 *   ?download=1 — adds Content-Disposition: attachment.
 *
 * Supports HTTP Range requests (206) so HTML5 video players can seek,
 * and we don't load 200MB files into memory just to serve a 64KB chunk.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  if (!getRun.get(id)) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const url = new URL(req.url);
  const rel = url.searchParams.get("p") ?? "final.mp4";
  const download = url.searchParams.get("download") === "1";

  const runDir = path.resolve(getRunDir(id));
  const target = path.resolve(path.join(runDir, rel));
  if (!target.startsWith(runDir + path.sep) && target !== runDir) {
    return NextResponse.json({ error: "path escape blocked" }, { status: 400 });
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return NextResponse.json({ error: "file not found", target }, { status: 404 });
  }

  const stat = fs.statSync(target);
  const size = stat.size;
  const ext = path.extname(target).toLowerCase();
  const mime =
    ext === ".mp4" ? "video/mp4" :
    ext === ".mp3" ? "audio/mpeg" :
    ext === ".png" ? "image/png" :
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
    "application/octet-stream";

  const baseHeaders: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0",
  };
  if (download) {
    baseHeaders["Content-Disposition"] = `attachment; filename="${path.basename(target)}"`;
  }

  // === Range request (for seeking in audio/video players) ===
  const rangeHeader = req.headers.get("range");
  if (rangeHeader) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }
      const chunkSize = end - start + 1;
      const buffer = Buffer.alloc(chunkSize);
      const fd = fs.openSync(target, "r");
      try {
        fs.readSync(fd, buffer, 0, chunkSize, start);
      } finally {
        fs.closeSync(fd);
      }
      return new Response(new Uint8Array(buffer), {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Length": String(chunkSize),
          "Content-Range": `bytes ${start}-${end}/${size}`,
        },
      });
    }
  }

  // === Full response ===
  const buffer = fs.readFileSync(target);
  return new Response(new Uint8Array(buffer), {
    headers: {
      ...baseHeaders,
      "Content-Length": String(size),
    },
  });
}

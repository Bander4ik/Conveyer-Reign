import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { runPipeline } from "@/lib/pipeline";
import { sanitizeFolderName, pickAvailableFolderName, getRunDir } from "@/lib/run-paths";

const insertRun = db.prepare(
  "INSERT INTO runs (id, title, folder_name, status, script, config_json) VALUES (?, ?, ?, 'pending', ?, ?)"
);
const setConfig = db.prepare("UPDATE runs SET config_json = ? WHERE id = ?");
const listRuns = db.prepare(
  "SELECT id, title, folder_name, status, created_at, updated_at, output_path FROM runs ORDER BY created_at DESC LIMIT 50"
);

/** A character as sent from the New Run form. Uploaded photos arrive as a
 *  base64 data URL and are written to disk here (we never store bytes in DB). */
interface CharacterInput {
  name?: string;
  isHost?: boolean;
  source?: "describe" | "upload" | "url";
  description?: string;
  imageUrl?: string;
  imageDataUrl?: string;
}

const MAX_CHARACTERS = 8;

function extFromMime(mime: string): string {
  if (/png/i.test(mime)) return "png";
  if (/jpe?g/i.test(mime)) return "jpg";
  if (/webp/i.test(mime)) return "webp";
  return "png";
}

export async function GET() {
  ensureInit();
  return NextResponse.json(listRuns.all());
}

export async function POST(req: Request) {
  ensureInit();
  const body = (await req.json()) as {
    title?: string;
    script?: string;
    characters?: CharacterInput[];
    channelId?: string;
  };
  const script = (body.script ?? "").trim();
  if (!script) {
    return NextResponse.json({ error: "script is empty" }, { status: 400 });
  }

  const id = randomUUID();
  const baseFolderName = sanitizeFolderName(body.title ?? "", id.slice(0, 8));
  const folderName = pickAvailableFolderName(baseFolderName);

  insertRun.run(id, body.title ?? null, folderName, script, JSON.stringify({}));

  // Build the cast. Uploaded photos (base64 data URLs) are decoded and written
  // to the run's characters/ folder; only the path is kept in config_json.
  const rawCast = Array.isArray(body.characters)
    ? body.characters.slice(0, MAX_CHARACTERS)
    : [];
  const charDir = path.join(getRunDir(id), "characters");
  const cast: Record<string, unknown>[] = [];
  for (let i = 0; i < rawCast.length; i++) {
    const c: CharacterInput = rawCast[i] ?? {};
    const name = (c.name ?? "").trim();
    if (!name) continue;
    const source = c.source === "upload" || c.source === "url" ? c.source : "describe";
    const entry: Record<string, unknown> = {
      id: `c${i}`,
      name,
      isHost: Boolean(c.isHost),
      source,
    };
    if (source === "describe") {
      entry.description = (c.description ?? "").trim();
    } else if (source === "url") {
      entry.imageUrl = (c.imageUrl ?? "").trim();
    } else if (source === "upload" && c.imageDataUrl) {
      const m = /^data:([^;]+);base64,(.+)$/s.exec(c.imageDataUrl);
      if (m) {
        try {
          fs.mkdirSync(charDir, { recursive: true });
          const p = path.join(charDir, `c${i}_input.${extFromMime(m[1])}`);
          fs.writeFileSync(p, Buffer.from(m[2], "base64"));
          entry.inputImagePath = p;
        } catch {
          // If we can't save the upload, keep the character (tagged by name)
          // but without a locked look.
        }
      }
    }
    cast.push(entry);
  }

  setConfig.run(
    JSON.stringify({ characters: cast, channelId: (body.channelId ?? "").trim() || null }),
    id
  );

  // Run the pipeline in the background. Fine for local single-user use.
  runPipeline(id, script).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("pipeline crash", e);
  });

  return NextResponse.json({ id, folderName });
}

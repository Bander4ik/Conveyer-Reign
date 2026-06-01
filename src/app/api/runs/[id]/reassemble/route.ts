import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { log } from "@/lib/logger";
import { assembleVideo, type AssembleInput } from "@/lib/services/video-assemble";
import { synthesizeScene } from "@/lib/services/tts";
import { generateImage } from "@/lib/services/image-gen";
import { splitScript, type Scene } from "@/lib/services/scene-split";
import { getRunDir } from "@/lib/run-paths";
import { pLimit } from "@/lib/plimit";
import { getSetting } from "@/lib/settings";

const getRun = db.prepare("SELECT id, script FROM runs WHERE id = ?");
const updateRun = db.prepare(
  "UPDATE runs SET status = ?, output_path = ?, updated_at = datetime('now') WHERE id = ?"
);

/**
 * Smart reassemble:
 *  1. Load scenes.json if it exists. Otherwise re-split the script.
 *  2. For scenes missing an image or audio file, regenerate just that asset.
 *  3. Re-run final assembly with the complete set.
 */
export async function POST(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const row = getRun.get(id) as { id: string; script: string } | undefined;
  if (!row) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const runDir = getRunDir(id);
  const audioDir = path.join(runDir, "audio");
  const imgDir = path.join(runDir, "images");
  if (!fs.existsSync(audioDir) && !fs.existsSync(imgDir)) {
    return NextResponse.json({ error: "no assets on disk" }, { status: 400 });
  }
  for (const d of [audioDir, imgDir]) fs.mkdirSync(d, { recursive: true });

  (async () => {
    try {
      updateRun.run("running", null, id);
      log(id, "info", "Smart reassemble: checking assets", { stage: "pipeline" });

      // 1. Get scenes
      let scenes: Scene[];
      const scenesFile = path.join(runDir, "scenes.json");
      if (fs.existsSync(scenesFile)) {
        scenes = JSON.parse(fs.readFileSync(scenesFile, "utf-8"));
        log(id, "info", `Loaded ${scenes.length} scenes from scenes.json`, { stage: "pipeline" });
      } else {
        log(id, "info", "scenes.json missing — re-splitting script via Gemini", { stage: "pipeline" });
        scenes = await splitScript(id, row.script);
        fs.writeFileSync(scenesFile, JSON.stringify(scenes, null, 2), "utf-8");
      }

      // 2. Find gaps
      function audioPath(idx: number) {
        return path.join(audioDir, `scene_${String(idx).padStart(3, "0")}.mp3`);
      }
      function imagePath(idx: number) {
        return path.join(imgDir, `scene_${String(idx).padStart(3, "0")}.png`);
      }
      const missingAudio = scenes.filter((s) => !fs.existsSync(audioPath(s.index)));
      const missingImage = scenes.filter((s) => !fs.existsSync(imagePath(s.index)));

      if (missingAudio.length || missingImage.length) {
        log(
          id,
          "info",
          `Filling gaps: ${missingImage.length} images, ${missingAudio.length} audio files`,
          { stage: "pipeline" }
        );
        const limitImg = pLimit(Math.max(1, Number(getSetting("IMAGE_CONCURRENCY") || "5")));
        const limitTts = pLimit(Math.max(1, Number(getSetting("TTS_CONCURRENCY") || "3")));

        await Promise.all([
          ...missingAudio.map((s) =>
            limitTts(() =>
              synthesizeScene(id, s, audioDir).catch((e) => {
                log(id, "warn", `Failed to regenerate audio #${s.index}: ${(e as Error).message}`, {
                  stage: "tts",
                });
              })
            )
          ),
          ...missingImage.map((s) =>
            limitImg(() =>
              generateImage(id, s, imgDir).catch((e) => {
                log(id, "warn", `Failed to regenerate image #${s.index}: ${(e as Error).message}`, {
                  stage: "image",
                });
              })
            )
          ),
        ]);
      } else {
        log(id, "info", "All assets present, running assembly only", { stage: "pipeline" });
      }

      // 3. Assemble only scenes that have BOTH audio and image
      const inputs: AssembleInput[] = [];
      for (const s of scenes) {
        const ap = audioPath(s.index);
        const ip = imagePath(s.index);
        if (!fs.existsSync(ap) || !fs.existsSync(ip)) {
          log(id, "warn", `Scene #${s.index} still incomplete — skipping`, { stage: "assemble" });
          continue;
        }
        const stat = fs.statSync(ap);
        inputs.push({
          scene: s,
          imagePath: ip,
          audio: { filePath: ap, durationSec: Math.max(1, stat.size / 16000) },
        });
      }
      if (inputs.length === 0) throw new Error("No complete scenes found");

      const finalPath = await assembleVideo(id, inputs, runDir);
      updateRun.run("done", finalPath, id);
      log(id, "success", `Reassemble complete (${inputs.length}/${scenes.length} scenes)`, {
        stage: "pipeline",
        data: { finalPath },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(id, "error", `Reassemble crashed: ${msg}`, { stage: "pipeline" });
      updateRun.run("error", null, id);
    }
  })().catch(() => {});

  return NextResponse.json({ ok: true });
}

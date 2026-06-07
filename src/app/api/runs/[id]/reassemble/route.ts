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
import { resolveChannel } from "@/lib/channels";

const getRun = db.prepare("SELECT id, script, config_json FROM runs WHERE id = ?");
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
  const row = getRun.get(id) as { id: string; script: string; config_json: string | null } | undefined;
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
      // Use the run's channel prompts when regenerating, so reassemble stays
      // consistent with how the run was made (not the global default prompt).
      let channelId: string | null = null;
      try {
        channelId = (JSON.parse(row.config_json || "{}") as { channelId?: string }).channelId ?? null;
      } catch {
        // malformed config — fall back to global prompts
      }
      const channel = resolveChannel(channelId);
      log(
        id,
        "info",
        `Smart reassemble: checking assets${channel.channelName ? ` · channel: ${channel.channelName}` : ""}`,
        { stage: "pipeline" }
      );

      // 1. Get scenes
      let scenes: Scene[];
      const scenesFile = path.join(runDir, "scenes.json");
      if (fs.existsSync(scenesFile)) {
        scenes = JSON.parse(fs.readFileSync(scenesFile, "utf-8"));
        log(id, "info", `Loaded ${scenes.length} scenes from scenes.json`, { stage: "pipeline" });
      } else {
        log(id, "info", "scenes.json missing — re-splitting script via Gemini", { stage: "pipeline" });
        scenes = await splitScript(id, row.script, [], channel.sceneSplit);
        fs.writeFileSync(scenesFile, JSON.stringify(scenes, null, 2), "utf-8");
      }

      // 2. Find gaps
      function audioPath(idx: number) {
        return path.join(audioDir, `scene_${String(idx).padStart(3, "0")}.mp3`);
      }
      function imageWritePath(idx: number) {
        return path.join(imgDir, `scene_${String(idx).padStart(3, "0")}.png`);
      }
      // A scene's still can be an AI .png OR a Pexels stock .jpg — accept either,
      // otherwise reassemble treats every stock photo as "missing" and overwrites
      // it with a fresh AI image.
      function existingImage(idx: number): string | null {
        const png = imageWritePath(idx);
        if (fs.existsSync(png)) return png;
        const jpg = path.join(imgDir, `scene_${String(idx).padStart(3, "0")}.jpg`);
        if (fs.existsSync(jpg)) return jpg;
        return null;
      }
      const missingAudio = scenes.filter((s) => !fs.existsSync(audioPath(s.index)));
      const missingImage = scenes.filter((s) => !existingImage(s.index));

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
              generateImage(id, s, imgDir, undefined, channel.imageStyle, channel.realSubjects).catch((e) => {
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
        const ip = existingImage(s.index);
        if (!fs.existsSync(ap) || !ip) {
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

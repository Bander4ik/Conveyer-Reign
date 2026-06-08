import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { log } from "@/lib/logger";
import { assembleVideo, extractOrSilentAudio, type AssembleInput } from "@/lib/services/video-assemble";
import { synthesizeScene } from "@/lib/services/tts";
import { writeSilentWav } from "@/lib/services/media-synth";
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
  const animDir = path.join(runDir, "animations");
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

      // 2. Find gaps. A scene's visual can be a clip (animations/*.mp4) OR a still
      //    (AI .png / Pexels .jpg). Audio depends on the channel's mode: voiceover
      //    → TTS; no voiceover → the clip's own sound or a silent track. Reassemble
      //    must mirror that — otherwise it wrongly generates a voiceover for a
      //    no-voiceover run.
      function audioPath(idx: number) {
        return path.join(audioDir, `scene_${String(idx).padStart(3, "0")}.mp3`);
      }
      function imageWritePath(idx: number) {
        return path.join(imgDir, `scene_${String(idx).padStart(3, "0")}.png`);
      }
      function existingImage(idx: number): string | null {
        const png = imageWritePath(idx);
        if (fs.existsSync(png)) return png;
        const jpg = path.join(imgDir, `scene_${String(idx).padStart(3, "0")}.jpg`);
        if (fs.existsSync(jpg)) return jpg;
        return null;
      }
      function existingClip(idx: number): string | null {
        const mp4 = path.join(animDir, `scene_${String(idx).padStart(3, "0")}.mp4`);
        return fs.existsSync(mp4) ? mp4 : null;
      }
      const sceneDur = Math.max(2, Number(getSetting("SCENE_DURATION_SECONDS") || "5"));

      const missingAudio = scenes.filter((s) => !fs.existsSync(audioPath(s.index)));
      // Only regenerate a still when a scene has NEITHER a clip NOR an image — we
      // can't cheaply re-create a Veo clip, so fall back to a fresh AI still.
      const missingVisual = scenes.filter((s) => !existingClip(s.index) && !existingImage(s.index));

      if (missingAudio.length || missingVisual.length) {
        log(
          id,
          "info",
          `Filling gaps: ${missingVisual.length} visuals, ${missingAudio.length} audio (${channel.voiceover ? "voiceover" : "no voiceover"})`,
          { stage: "pipeline" }
        );
        const limitImg = pLimit(Math.max(1, Number(getSetting("IMAGE_CONCURRENCY") || "5")));
        const limitTts = pLimit(Math.max(1, Number(getSetting("TTS_CONCURRENCY") || "3")));

        await Promise.all([
          ...missingAudio.map((s) =>
            limitTts(async () => {
              try {
                if (channel.voiceover) {
                  await synthesizeScene(id, s, audioDir);
                } else {
                  // No voiceover: reuse the clip's own audio (or silence) — never TTS.
                  const clip = existingClip(s.index);
                  if (clip) {
                    await extractOrSilentAudio(clip, audioPath(s.index), channel.keepClipAudio, sceneDur);
                  } else {
                    writeSilentWav(audioPath(s.index), sceneDur);
                  }
                }
              } catch (e) {
                log(id, "warn", `Failed to fill audio #${s.index}: ${(e as Error).message}`, { stage: "tts" });
              }
            })
          ),
          ...missingVisual.map((s) =>
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

      // 3. Assemble every scene that has audio + a visual. Prefer the clip
      //    (videoPath → rendered as a clip); otherwise Ken-Burns the still.
      //    assembleVideo re-probes the real audio duration via ffprobe, so the
      //    durationSec hint here is just a placeholder.
      const inputs: AssembleInput[] = [];
      for (const s of scenes) {
        const ap = audioPath(s.index);
        const clip = existingClip(s.index);
        const img = existingImage(s.index);
        if (!fs.existsSync(ap) || (!clip && !img)) {
          log(id, "warn", `Scene #${s.index} still incomplete — skipping`, { stage: "assemble" });
          continue;
        }
        inputs.push({
          scene: s,
          imagePath: img ?? (clip as string),
          videoPath: clip,
          audio: { filePath: ap, durationSec: 1 },
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

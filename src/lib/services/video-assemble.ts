import path from "node:path";
import fs from "node:fs";
import ffmpeg from "fluent-ffmpeg";
import { getSetting } from "../settings";
import { log } from "../logger";
import { pLimit } from "../plimit";
import type { Scene } from "./scene-split";
import type { TtsResult } from "./tts";

export interface AssembleInput {
  scene: Scene;
  imagePath: string;
  videoPath?: string | null;
  audio: TtsResult;
}

/**
 * Builds the final video using random Ken-Burns clips + xfade transitions.
 *
 * Steps:
 *  1. For each scene render a clip whose duration matches its audio (measured via ffprobe).
 *     - Ken-Burns: random zoom-in (1.0→1.18) or zoom-out (1.18→1.0)
 *     - If videoPath (img2vid) is provided, that clip is used as the base instead
 *  2. Concat all clips with xfade on the boundaries (smooth crossfade).
 *     - If TRANSITION_DURATION = 0 → simple concat without transitions.
 */
export async function assembleVideo(
  runId: string,
  scenes: AssembleInput[],
  outDir: string
): Promise<string> {
  const ffmpegPath = getSetting("FFMPEG_PATH");
  if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
    // ffprobe lives next to ffmpeg in the same bin/ folder
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    if (fs.existsSync(ffprobePath)) ffmpeg.setFfprobePath(ffprobePath);
  }

  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const transitionSec = Number(getSetting("TRANSITION_DURATION") || "0.5");
  const tailSilence = Math.max(0, Number(getSetting("SCENE_TAIL_SILENCE") || "0.4"));
  const assembleConcurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const clipsDir = path.join(outDir, "clips");
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

  log(runId, "info", `Assembling ${scenes.length} clips (${resolution} @${fps}fps, ${assembleConcurrency} in parallel)`, {
    stage: "assemble",
  });

  // 1. Render individual clips in PARALLEL (was sequential before).
  //    Preserve ordering by index — Promise.all does not guarantee completion order.
  const limitClip = pLimit(assembleConcurrency);
  const indexed: ({ path: string; durationSec: number; index: number })[] = await Promise.all(
    scenes.map((item) =>
      limitClip(async () => {
        const clipPath = path.join(
          clipsDir,
          `clip_${String(item.scene.index).padStart(3, "0")}.mp4`
        );
        const audioDuration = await probeDuration(item.audio.filePath);
        // Total clip duration = audio + silence padding at the end so consecutive
        // scenes get a natural breath between them after concat.
        const clipDuration = audioDuration + tailSilence;
        if (item.videoPath) {
          await renderAnimatedClip(item.videoPath, item.audio.filePath, clipPath, w, h, fps, clipDuration, tailSilence);
        } else {
          const zoomDirection: "in" | "out" = Math.random() < 0.5 ? "in" : "out";
          await renderKenBurnsClip(item.imagePath, item.audio.filePath, clipPath, w, h, fps, clipDuration, zoomDirection, tailSilence);
        }
        log(
          runId,
          "info",
          `Clip #${item.scene.index} (${audioDuration.toFixed(1)}s audio + ${tailSilence}s silence = ${clipDuration.toFixed(1)}s, ${item.videoPath ? "img2vid" : "ken-burns"}) done`,
          { stage: "assemble" }
        );
        return { path: clipPath, durationSec: clipDuration, index: item.scene.index };
      })
    )
  );
  indexed.sort((a, b) => a.index - b.index);
  const clipInfos = indexed.map((c) => ({ path: c.path, durationSec: c.durationSec }));

  // 2. Concat
  const finalPath = path.join(outDir, "final.mp4");
  if (transitionSec > 0 && clipInfos.length >= 2) {
    // Two-tier strategy:
    //  - Small video (≤ MAX_CLIPS_PER_PASS): one monolithic xfade ffmpeg call.
    //  - Large video: hierarchical xfade — cap each ffmpeg at MAX_CLIPS_PER_PASS
    //    inputs and run them with bounded parallelism, then collapse the
    //    intermediates in another pass. Repeats until ≤ MAX_CLIPS_PER_PASS remain.
    //
    // A monolithic xfade with hundreds of inputs blows past the system file-
    // descriptor limit on macOS and Windows ("Resource temporarily unavailable" /
    // EAGAIN) and ffmpeg crashes. The bounded-fan-in scheme keeps every ffmpeg
    // process well under any reasonable per-process FD limit.
    //
    // `ASSEMBLE_XFADE_CHUNKS=1` forces the legacy monolithic path (useful for
    // debugging — but it will crash on long videos).
    const xfadeChunks = Math.max(1, Number(getSetting("ASSEMBLE_XFADE_CHUNKS") || "4"));
    if (xfadeChunks > 1 && clipInfos.length >= xfadeChunks * 3) {
      await concatWithCrossfadeChunked(runId, clipInfos, clipsDir, finalPath, transitionSec, fps);
    } else {
      await concatWithCrossfade(clipInfos, finalPath, transitionSec, fps);
      log(runId, "info", `Crossfade ${transitionSec}s across ${clipInfos.length} scenes`, { stage: "assemble" });
    }
  } else {
    await concatSimple(clipInfos.map((c) => c.path), clipsDir, finalPath);
  }

  log(runId, "success", `Final video: ${finalPath}`, { stage: "assemble" });
  return finalPath;
}

/** Reads the exact audio duration via ffprobe. */
function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      const d = data.format?.duration;
      if (typeof d !== "number" || !isFinite(d)) {
        // Fallback: estimate from file size
        const stat = fs.statSync(filePath);
        return resolve(Math.max(1, stat.size / 16000));
      }
      resolve(d);
    });
  });
}

/**
 * Ken-Burns clip: still image with a slow zoom plus optional gentle pan.
 * direction = 'in' → 1.0 → 1.18, 'out' → 1.18 → 1.0.
 */
function renderKenBurnsClip(
  imagePath: string,
  audioPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  direction: "in" | "out",
  tailSilenceSec: number = 0
): Promise<void> {
  const totalFrames = Math.max(2, Math.ceil(durationSec * fps));
  const minZoom = 1.0;
  const maxZoom = 1.18;

  // zoom expression — linear interpolation through `on` (output frame index)
  const zoomExpr =
    direction === "in"
      ? `min(${minZoom}+(${maxZoom}-${minZoom})*on/${totalFrames - 1},${maxZoom})`
      : `max(${maxZoom}-(${maxZoom}-${minZoom})*on/${totalFrames - 1},${minZoom})`;

  // Slight random pan: choose one of 5 trajectories
  const panChoice = Math.floor(Math.random() * 5);
  let xExpr = `iw/2-(iw/zoom/2)`; // center
  let yExpr = `ih/2-(ih/zoom/2)`;
  switch (panChoice) {
    case 1: // top-left → bottom-right drift
      xExpr = `(iw-iw/zoom)*on/${totalFrames - 1}`;
      yExpr = `(ih-ih/zoom)*on/${totalFrames - 1}`;
      break;
    case 2: // top-right → bottom-left
      xExpr = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
      yExpr = `(ih-ih/zoom)*on/${totalFrames - 1}`;
      break;
    case 3: // bottom-left → top-right
      xExpr = `(iw-iw/zoom)*on/${totalFrames - 1}`;
      yExpr = `(ih-ih/zoom)*(1-on/${totalFrames - 1})`;
      break;
    case 4: // bottom-right → top-left
      xExpr = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
      yExpr = `(ih-ih/zoom)*(1-on/${totalFrames - 1})`;
      break;
    // case 0 — center, no pan
  }

  // Upscale the input ×2 so the zoom doesn't blur
  const filter = `scale=${w * 2}:${h * 2}:flags=lanczos,zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(imagePath)
      .inputOptions(["-loop 1"])
      .input(audioPath)
      .videoFilters(filter);
    // Pad audio with silence at the end so consecutive scenes get a breath.
    if (tailSilenceSec > 0) {
      cmd.audioFilters(`apad=pad_dur=${tailSilenceSec.toFixed(3)}`);
    }
    cmd
      .outputOptions([
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/** img2vid clip: render the Veo clip with its length matched to the TTS audio.
 *
 *  Veo always produces a fixed-length clip (4/6/8 s — capped at 8 s). When the
 *  TTS narration for a scene runs LONGER than the Veo clip we used to loop the
 *  Veo input with `-stream_loop -1` and rely on `-t` to cut. That made the clip
 *  visibly restart from frame 1 around the 7-8 s mark — the "scene replays"
 *  glitch users noticed on long sentences.
 *
 *  New strategy (no more abrupt loop):
 *    1. If audio ≤ video: just cut with `-t` (no transform).
 *    2. If audio overruns up to 1.5×: time-stretch the Veo clip with `setpts`
 *       (subtle slow-motion that documentary viewers won't notice).
 *    3. If audio overruns more: stretch to 1.5× then freeze the LAST frame
 *       via `tpad=stop_mode=clone` for the remaining time. Better than a
 *       jarring restart, and feels like the camera "settling".
 *
 *  Audio comes ONLY from the TTS mp3 (input 1) — Veo's own audio (input 0) is
 *  dropped via explicit -map.
 */
async function renderAnimatedClip(
  videoPath: string,
  audioPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  tailSilenceSec: number = 0
): Promise<void> {
  const videoDur = await probeDuration(videoPath);

  let videoFilter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  if (durationSec > videoDur + 0.05) {
    // Drop MAX_STRETCH from 1.5 to 1.15. Past ~1.15 the effective motion FPS
    // drops below ~21 (24 / 1.15) and the image looks juddery — that's the
    // "low FPS / picture jumps" symptom users have complained about.
    // We'd rather freeze the last frame than stretch into ugly slow-mo.
    const MAX_STRETCH = 1.15;
    const stretchFactor = Math.min(durationSec / videoDur, MAX_STRETCH);
    if (stretchFactor > 1.01) {
      // CRITICAL: setpts alone makes ffmpeg space the SAME frames over a
      // longer timeline → effective motion FPS = source_fps / stretchFactor.
      // Pair it with `fps=N` so ffmpeg duplicates frames at the target rate
      // and the playback timing stays uniform. (Real motion interpolation
      // would need `minterpolate`, but that's too slow for batch.)
      videoFilter = `setpts=${stretchFactor.toFixed(3)}*PTS,fps=${fps},${videoFilter}`;
    }
    const stretchedDur = videoDur * stretchFactor;
    const freezeNeeded = Math.max(0, durationSec - stretchedDur);
    if (freezeNeeded > 0.05) {
      videoFilter = `${videoFilter},tpad=stop_mode=clone:stop_duration=${freezeNeeded.toFixed(3)}`;
    }
  }

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .videoFilters(videoFilter);
    if (tailSilenceSec > 0) {
      cmd.audioFilters(`apad=pad_dur=${tailSilenceSec.toFixed(3)}`);
    }
    cmd
      .outputOptions([
        // Explicit stream mapping — drops Veo's audio even if `mute` didn't work
        "-map", "0:v:0",
        "-map", "1:a:0",
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/** Simple stream-copy concat (no transitions). */
function concatSimple(clipPaths: string[], clipsDir: string, finalPath: string): Promise<void> {
  const listFile = path.join(clipsDir, "concat.txt");
  fs.writeFileSync(listFile, clipPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"), "utf-8");
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(finalPath);
  });
}

/**
 * Hierarchical chunked concat-with-crossfade.
 *
 * Two problems with a monolithic xfade across hundreds of clips:
 *   1. FFmpeg's chained xfade graph is serial (each xfade depends on the
 *      previous output), so a single 100-clip xfade can't use multiple cores.
 *   2. Each ffmpeg input is an open file. Past ~150-200 inputs we blow the
 *      system per-process file-descriptor limit (256 default on macOS, 512 on
 *      Windows) and ffmpeg crashes with "Resource temporarily unavailable"
 *      (EAGAIN) when binding the filtergraph.
 *
 * Strategy: cap each ffmpeg invocation at MAX_CLIPS_PER_PASS inputs, run them
 * with bounded parallelism (MAX_PARALLEL), then collapse the intermediates
 * the same way. Repeat the level until ≤ MAX_CLIPS_PER_PASS clips remain —
 * that's the final pass that writes finalPath.
 *
 * Examples (MAX_CLIPS_PER_PASS=50):
 *   100 clips  → L0: 2 chunks × 50 (2 parallel) → L1: 2 → final. 2 levels.
 *   1600 clips → L0: 32 chunks × 50 (4 parallel) → L1: 32 ≤ 50 → final. 2 levels.
 *   5000 clips → L0: 100 chunks × 50 → L1: 2 chunks × 50 → L2: 2 → final. 3 levels.
 */
async function concatWithCrossfadeChunked(
  runId: string,
  clips: { path: string; durationSec: number }[],
  clipsDir: string,
  finalPath: string,
  fadeDur: number,
  fps: number
): Promise<void> {
  const MAX_CLIPS_PER_PASS = Math.max(
    2,
    Number(getSetting("ASSEMBLE_XFADE_MAX_CLIPS_PER_PASS") || "50")
  );
  const baseParallel = Math.max(
    1,
    Number(getSetting("ASSEMBLE_CONCURRENCY") || "4")
  );
  // RAM-aware throttle: each ffmpeg holds ~MAX_CLIPS_PER_PASS inputs in memory
  // plus buffered frames. On a 16-GB laptop, 4 parallel ffmpegs each pulling
  // 50 inputs can spill into swap and freeze the whole machine — which feels
  // to the user like "the whole app slowed down". For huge videos (where the
  // pain is real) cap parallelism at 2 even if ASSEMBLE_CONCURRENCY is higher.
  const isLargeVideo = clips.length >= 500;
  const MAX_PARALLEL = isLargeVideo ? Math.min(baseParallel, 2) : baseParallel;
  if (isLargeVideo && baseParallel > MAX_PARALLEL) {
    log(
      runId,
      "info",
      `Large video (${clips.length} clips) — throttling assemble concurrency ${baseParallel} → ${MAX_PARALLEL} to keep RAM usage bounded`,
      { stage: "assemble" }
    );
  }

  let current = clips;
  let level = 0;
  const intermediateFiles: string[] = [];

  // Keep collapsing until current.length fits in one final ffmpeg call.
  while (current.length > MAX_CLIPS_PER_PASS) {
    // Distribute clips evenly across chunks so no chunk is wildly bigger.
    const chunkCount = Math.ceil(current.length / MAX_CLIPS_PER_PASS);
    const baseSize = Math.floor(current.length / chunkCount);
    const extra = current.length % chunkCount;

    const chunks: { path: string; durationSec: number }[][] = [];
    let cursor = 0;
    for (let i = 0; i < chunkCount; i++) {
      const size = baseSize + (i < extra ? 1 : 0);
      chunks.push(current.slice(cursor, cursor + size));
      cursor += size;
    }

    log(
      runId,
      "info",
      `xfade L${level}: ${current.length} clips → ${chunkCount} chunks (~${baseSize}${extra > 0 ? "-" + (baseSize + 1) : ""} each), ` +
        `${Math.min(MAX_PARALLEL, chunkCount)} in parallel`,
      { stage: "assemble" }
    );

    const limit = pLimit(MAX_PARALLEL);
    const nextLevel: { path: string; durationSec: number }[] = await Promise.all(
      chunks.map((chunkClips, idx) =>
        limit(async () => {
          // Single-clip chunk: pass through, no ffmpeg pass needed.
          if (chunkClips.length === 1) return chunkClips[0];
          const chunkPath = path.join(
            clipsDir,
            `xfade_L${level}_${String(idx).padStart(3, "0")}.mp4`
          );
          await concatWithCrossfade(chunkClips, chunkPath, fadeDur, fps);
          intermediateFiles.push(chunkPath);
          // Chunk duration = sum(clip durations) − (N−1) × fadeDur (each xfade overlaps)
          const chunkDuration =
            chunkClips.reduce((s, c) => s + c.durationSec, 0) -
            (chunkClips.length - 1) * fadeDur;
          log(
            runId,
            "info",
            `xfade L${level} #${idx}: ${chunkClips.length} clips → ${chunkDuration.toFixed(1)}s`,
            { stage: "assemble" }
          );
          return { path: chunkPath, durationSec: chunkDuration };
        })
      )
    );

    current = nextLevel;
    level++;
  }

  // Final pass — `current` now has ≤ MAX_CLIPS_PER_PASS clips.
  log(
    runId,
    "info",
    `xfade final pass: ${current.length} ${current.length === 1 ? "clip" : "clips"} → final.mp4`,
    { stage: "assemble" }
  );
  if (current.length === 1) {
    // Only one clip survived (rare — happens when total ≤ MAX_CLIPS_PER_PASS-1
    // and the caller still chose chunked path, OR after a chain of pass-throughs).
    fs.copyFileSync(current[0].path, finalPath);
  } else {
    await concatWithCrossfade(current, finalPath, fadeDur, fps);
  }

  // Cleanup intermediate chunk files
  for (const f of intermediateFiles) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
}

/**
 * Concat with xfade transitions between clips.
 * fadeDur — transition length in seconds (e.g. 0.5).
 * On each boundary, the last fadeDur seconds of clip N overlap the first fadeDur of clip N+1.
 */
function concatWithCrossfade(
  clips: { path: string; durationSec: number }[],
  finalPath: string,
  fadeDur: number,
  fps: number
): Promise<void> {
  const cmd = ffmpeg();
  for (const c of clips) cmd.input(c.path);

  // Build filter_complex: chained xfade for video + acrossfade for audio.
  let videoChain = "";
  let audioChain = "";
  let lastV = "0:v";
  let lastA = "0:a";

  // Accumulated offset for xfade: sum of (prevDuration - fadeDur)
  let cumOffset = 0;
  for (let i = 1; i < clips.length; i++) {
    cumOffset += clips[i - 1].durationSec - fadeDur;
    const vOut = `v${i}`;
    const aOut = `a${i}`;
    videoChain += `[${lastV}][${i}:v]xfade=transition=fade:duration=${fadeDur}:offset=${cumOffset.toFixed(3)}[${vOut}];`;
    audioChain += `[${lastA}][${i}:a]acrossfade=d=${fadeDur}[${aOut}];`;
    lastV = vOut;
    lastA = aOut;
  }
  // Strip trailing ;
  const filterComplex = (videoChain + audioChain).replace(/;$/, "");

  return new Promise((resolve, reject) => {
    cmd
      .complexFilter(filterComplex)
      .outputOptions([
        `-map [${lastV}]`,
        `-map [${lastA}]`,
        `-r ${fps}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 22",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .on("error", reject)
      .on("end", () => resolve())
      .save(finalPath);
  });
}

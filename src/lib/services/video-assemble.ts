import path from "node:path";
import fs from "node:fs";
import ffmpeg from "fluent-ffmpeg";
import { getSetting } from "../settings";
import { log } from "../logger";
import { pLimit } from "../plimit";
import type { Scene } from "./scene-split";
import type { TtsResult } from "./tts";
import { writeSilentWav } from "./media-synth";

export interface AssembleInput {
  scene: Scene;
  imagePath: string;
  videoPath?: string | null;
  audio: TtsResult;
  /** Intro stat card etc. — show the image full-frame, static (no Ken-Burns zoom/pan). */
  staticCard?: boolean;
  /** When set (1–100) and the Veo clip carries its own audio, mix that ambient
   *  UNDER the narration at this volume % instead of dropping it. Voiceover mode
   *  only (set by the pipeline / reassemble from VEO_DUCK_PERCENT). */
  mixVeoPercent?: number;
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
    if (fs.existsSync(ffprobePath)) {
      ffmpeg.setFfprobePath(ffprobePath);
    } else {
      log(
        runId,
        "warn",
        `ffprobe not found next to ffmpeg (${ffprobePath}) — scene durations will be ESTIMATED. Install a full ffmpeg build (with ffprobe.exe in the same bin folder) and point FFMPEG_PATH at its ffmpeg.exe for exact timing.`,
        { stage: "assemble" }
      );
    }
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
  type RenderedClip = { path: string; durationSec: number; index: number };
  const settled: (RenderedClip | null)[] = await Promise.all(
    scenes.map((item) =>
      limitClip(async () => {
        const clipPath = path.join(
          clipsDir,
          `clip_${String(item.scene.index).padStart(3, "0")}.mp4`
        );
        try {
          const audioDuration = await probeDuration(item.audio.filePath);
          // Total clip duration = audio + silence padding at the end so consecutive
          // scenes get a natural breath between them after concat.
          let clipDuration = audioDuration + tailSilence;
          // Issue #2: a real Veo clip carries ~5-8s of motion, but short narration
          // (~1s) used to trim it to ~1.4s — you'd see only the first beat. Give
          // img2vid clips a minimum on-screen length so the motion plays out. We
          // never extend PAST the real footage (that would freeze-pad), and audio
          // is padded with trailing silence in renderAnimatedClip. Stills/Ken-Burns
          // are unaffected (this targets actual Veo clips only).
          if (item.videoPath && !item.staticCard) {
            const minAnim = Math.max(0, Number(getSetting("MIN_ANIMATED_CLIP_SECONDS") || "4.5"));
            if (clipDuration < minAnim) {
              const videoDur = await probeDuration(item.videoPath);
              clipDuration = Math.min(Math.max(clipDuration, minAnim), Math.max(clipDuration, videoDur));
            }
          }
          // Per-substep trace: which render path + the durations feeding it, so a
          // stalled clip is pinpointed to its exact branch in the log.
          log(
            runId,
            "debug",
            `Clip #${item.scene.index} render start: ${item.staticCard ? "static" : item.videoPath ? "img2vid" : "ken-burns"} · audio ${audioDuration.toFixed(2)}s · clip ${clipDuration.toFixed(2)}s`,
            { stage: "assemble" }
          );
          if (item.staticCard) {
            await renderStaticClip(runId, item.imagePath, item.audio.filePath, clipPath, w, h, fps, clipDuration, tailSilence);
          } else if (item.videoPath) {
            await renderAnimatedClip(runId, item.videoPath, item.audio.filePath, clipPath, w, h, fps, clipDuration, tailSilence, item.mixVeoPercent);
          } else {
            const zoomDirection: "in" | "out" = Math.random() < 0.5 ? "in" : "out";
            await renderKenBurnsClip(runId, item.imagePath, item.audio.filePath, clipPath, w, h, fps, clipDuration, zoomDirection, tailSilence);
          }
          log(
            runId,
            "info",
            `Clip #${item.scene.index} (${audioDuration.toFixed(1)}s audio + ${tailSilence}s silence = ${clipDuration.toFixed(1)}s, ${item.videoPath ? "img2vid" : "ken-burns"}) done`,
            { stage: "assemble" }
          );
          return { path: clipPath, durationSec: clipDuration, index: item.scene.index };
        } catch (e) {
          // Isolate a bad asset: skip this ONE clip instead of failing the whole
          // video at the final assembly stage (one corrupt clip used to abort all).
          log(runId, "warn", `Clip #${item.scene.index} failed to render, skipping: ${(e as Error).message.slice(0, 160)}`, {
            stage: "assemble",
          });
          return null;
        }
      })
    )
  );
  const indexed = settled.filter((c): c is RenderedClip => c !== null);
  if (indexed.length === 0) throw new Error("All scene clips failed to render");
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
      await concatWithCrossfade(runId, clipInfos, finalPath, transitionSec, fps);
      log(runId, "info", `Crossfade ${transitionSec}s across ${clipInfos.length} scenes`, { stage: "assemble" });
    }
  } else {
    await concatSimple(runId, clipInfos.map((c) => c.path), clipsDir, finalPath);
  }

  log(runId, "success", `Final video: ${finalPath}`, { stage: "assemble" });
  return finalPath;
}

/**
 * Estimate audio duration WITHOUT ffprobe — used when ffprobe is missing or
 * fails. Exact for our PCM WAVs (read the header's byte-rate + data size); a
 * ~128 kbps approximation for everything else (mp3 voiceover).
 */
function estimateDuration(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    try {
      const head = Buffer.alloc(44);
      const n = fs.readSync(fd, head, 0, 44, 0);
      if (
        n >= 44 &&
        head.toString("ascii", 0, 4) === "RIFF" &&
        head.toString("ascii", 8, 12) === "WAVE"
      ) {
        const byteRate = head.readUInt32LE(28); // bytes/sec
        const dataSize = head.readUInt32LE(40); // canonical 44-byte header layout
        if (byteRate > 0 && dataSize > 0) return Math.max(0.1, dataSize / byteRate);
      }
    } finally {
      fs.closeSync(fd);
    }
    return Math.max(1, stat.size / 16000); // ~128 kbps mp3
  } catch {
    return 3;
  }
}

/**
 * Reads the audio duration via ffprobe. If ffprobe is missing/unavailable
 * ("Cannot find ffprobe") or returns no duration, it FALLS BACK to a size-based
 * estimate instead of rejecting — so a missing ffprobe degrades the run (slightly
 * off scene lengths) rather than failing every clip.
 */
export function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    // ffprobe can BLOCK indefinitely on a malformed/truncated mp4 (the callback
    // never fires). Without this timer the awaiting render hangs forever before
    // its own ffmpeg even starts. On timeout we fall back to the size estimate.
    let settled = false;
    const finish = (v: number) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(estimateDuration(filePath)), ffprobeTimeoutMs());
    ffmpeg.ffprobe(filePath, (err, data) => {
      clearTimeout(timer);
      if (err) return finish(estimateDuration(filePath));
      const d = data.format?.duration;
      if (typeof d !== "number" || !isFinite(d)) return finish(estimateDuration(filePath));
      finish(d);
    });
  });
}

/** True when the file carries at least one audio stream (ffprobe). Used to
 *  decide whether Veo's ambient can be mixed under the narration — a muted or
 *  audio-less clip has nothing to blend, so we skip the mix and avoid an amix
 *  error on a missing [0:a]. Missing/failing ffprobe → false (safe: TTS only). */
function hasAudioStream(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // Same anti-hang timer as probeDuration — a blocked ffprobe degrades to
    // "no audio stream" (safe: TTS-only mix) instead of stalling the render.
    const timer = setTimeout(() => finish(false), ffprobeTimeoutMs());
    ffmpeg.ffprobe(filePath, (err, data) => {
      clearTimeout(timer);
      if (err || !data?.streams) return finish(false);
      finish(data.streams.some((s) => s.codec_type === "audio"));
    });
  });
}

// ── Anti-hang ffmpeg wrapper ────────────────────────────────────────────────
// Every render/concat/mux used to be `new Promise((res,rej)=>ffmpeg()...on('end')
// .on('error')...save())` with NO timeout. If the child deadlocks (pipe stall),
// blocks on a malformed input, or its completion event is lost, that Promise
// never settles — it holds a pLimit slot and the outer Promise.all never
// resolves, so assembly hangs SILENTLY until the user cancels (exactly what we
// saw: clips #3/#4 never logged "done", no xfade pass, 5 min dead, then cancel).

function ffprobeTimeoutMs(): number {
  return Math.max(5_000, Number(getSetting("FFPROBE_TIMEOUT_MS") || "30000"));
}
function ffmpegStallMs(): number {
  return Math.max(15_000, Number(getSetting("ASSEMBLE_FFMPEG_STALL_MS") || "120000"));
}

/**
 * Run a fully-configured fluent-ffmpeg command to `outPath` with a STALL timeout:
 * the timer resets on every progress/stderr tick, so a slow-but-working encode is
 * never killed, but a child that goes silent for `stallMs` is SIGKILLed and the
 * promise rejects. A rejection here is caught by the per-clip try/catch upstream,
 * so a hung clip becomes a skipped clip and assembly proceeds — never an infinite
 * hang. Logs the resolved ffmpeg command line (debug) and the stderr tail on
 * failure so the exact blocking call is visible next time.
 */
function runFfmpegSave(
  cmd: ffmpeg.FfmpegCommand,
  outPath: string,
  opts: { runId?: string; label: string; stallMs?: number }
): Promise<void> {
  const { runId, label } = opts;
  const stallMs = opts.stallMs ?? ffmpegStallMs();
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let stderrTail = "";
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      if (done) return; // never (re)arm after the promise has settled
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        if (runId) {
          log(runId, "error", `[ffmpeg stall] ${label} — no progress for ${stallMs}ms, killing. stderr tail: ${stderrTail.slice(-400)}`, { stage: "assemble" });
        }
        try {
          cmd.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        reject(new Error(`ffmpeg stalled >${stallMs}ms (${label})`));
      }, stallMs);
    };
    cmd
      .on("start", (cl: string) => {
        if (runId) log(runId, "debug", `[ffmpeg start] ${label}: ${cl.slice(0, 500)}`, { stage: "assemble" });
        arm();
      })
      .on("progress", () => arm())
      .on("stderr", (line: string) => {
        stderrTail = (stderrTail + "\n" + line).slice(-1500);
        arm();
      })
      .on("error", (err: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error(`${err.message}${stderrTail ? ` | ffmpeg stderr: ${stderrTail.slice(-300)}` : ""}`));
      })
      .on("end", () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      })
      .save(outPath);
    arm(); // in case 'start' is delayed by spawn
  });
}

/**
 * No-voiceover scenes still need a per-scene audio file so the assembly path
 * (which always expects one) works unchanged. With keepClipAudio + a clip that
 * has audio → extract the clip's own sound; otherwise → a silent track the
 * length of the clip. Returns the duration used. The ffmpeg path is configured
 * here because this runs during scene production, before assembleVideo sets it.
 */
export async function extractOrSilentAudio(
  videoPath: string,
  outPath: string,
  keepClipAudio: boolean,
  maxDurSec: number
): Promise<number> {
  const ffmpegPath = getSetting("FFMPEG_PATH");
  if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    if (fs.existsSync(ffprobePath)) ffmpeg.setFfprobePath(ffprobePath);
  }
  // Cap the no-voiceover scene length: a raw Pexels clip can be 10-30s, which
  // would make one scene that long. A probe failure also falls back to maxDur.
  let dur: number;
  try {
    dur = await probeDuration(videoPath);
  } catch {
    dur = maxDurSec;
  }
  dur = Math.min(dur, maxDurSec);
  if (keepClipAudio) {
    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(videoPath)
          // -t caps the extracted audio to the scene length. A raw Pexels clip can
          // be 10-30s and assembly derives each scene's length from THIS file's
          // duration (ffprobe), so without the trim one scene would run 10-30s.
          .outputOptions([`-t ${dur.toFixed(3)}`, "-vn", "-acodec", "libmp3lame", "-q:a", "4"])
          .on("error", reject)
          .on("end", () => resolve())
          .save(outPath);
      });
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return dur;
    } catch {
      // clip has no audio stream — fall through to a silent track
    }
  }
  await silentTrack(outPath, dur);
  return dur;
}

function silentTrack(outPath: string, durationSec: number): Promise<void> {
  // lavfi-free silence: write a PCM WAV directly instead of `-f lavfi -i
  // anullsrc`, which fails on ffmpeg builds without the lavfi input device.
  // The Ken-Burns / static clips re-encode this to AAC, so the .mp3 name and
  // WAV container don't matter.
  writeSilentWav(outPath, Math.max(0.5, durationSec));
  return Promise.resolve();
}

/**
 * Grab the LAST frame of a clip as a PNG. Motion continuity feeds this frame to
 * the NEXT scene's img2vid so the action continues from exactly where the
 * previous clip ended, instead of restarting. Seeks ~0.2s before EOF and takes
 * a single frame. Rejects on failure so the caller can fall back to a fresh
 * image. Runs during scene production (before assembleVideo), so it configures
 * FFMPEG_PATH itself — same pattern as extractOrSilentAudio.
 */
export function extractLastFrame(videoPath: string, outPath: string): Promise<void> {
  const ffmpegPath = getSetting("FFMPEG_PATH");
  if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    if (fs.existsSync(ffprobePath)) ffmpeg.setFfprobePath(ffprobePath);
  }
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      // -sseof seeks relative to EOF; -0.2 = 0.2s before the end → the last frame.
      .inputOptions(["-sseof", "-0.2"])
      .outputOptions(["-frames:v", "1", "-q:v", "2", "-update", "1"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/**
 * Ken-Burns clip: still image with a slow zoom plus optional gentle pan.
 * direction = 'in' → 1.0 → 1.18, 'out' → 1.18 → 1.0.
 */
function renderKenBurnsClip(
  runId: string,
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

  const cmd = ffmpeg()
    .input(imagePath)
    .inputOptions(["-loop 1"])
    .input(audioPath)
    .videoFilters(filter);
  // Pad audio with silence at the end so consecutive scenes get a breath.
  if (tailSilenceSec > 0) {
    cmd.audioFilters(`apad=pad_dur=${tailSilenceSec.toFixed(3)}`);
  }
  cmd.outputOptions([
    `-r ${fps}`,
    `-t ${durationSec.toFixed(3)}`,
    "-c:v libx264",
    "-preset veryfast",
    "-crf 23",
    "-pix_fmt yuv420p",
    "-c:a aac",
    "-b:a 192k",
    "-movflags +faststart",
  ]);
  return runFfmpegSave(cmd, outPath, { runId, label: `ken-burns ${path.basename(outPath)}` });
}

/** Static full-frame clip (no zoom/pan) — used for the intro stat card so its
 *  text never gets cropped by a Ken-Burns move. The image is already w×h. */
function renderStaticClip(
  runId: string,
  imagePath: string,
  audioPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  tailSilenceSec: number = 0
): Promise<void> {
  const filter = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0e0f13,setsar=1,fps=${fps}`;
  const cmd = ffmpeg()
    .input(imagePath)
    .inputOptions(["-loop 1"])
    .input(audioPath)
    .videoFilters(filter);
  if (tailSilenceSec > 0) {
    cmd.audioFilters(`apad=pad_dur=${tailSilenceSec.toFixed(3)}`);
  }
  cmd.outputOptions([
    `-r ${fps}`,
    `-t ${durationSec.toFixed(3)}`,
    "-c:v libx264",
    "-preset veryfast",
    "-crf 23",
    "-pix_fmt yuv420p",
    "-c:a aac",
    "-b:a 192k",
    "-movflags +faststart",
  ]);
  return runFfmpegSave(cmd, outPath, { runId, label: `static ${path.basename(outPath)}` });
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
 *  Audio: by default ONLY the TTS mp3 (input 1) — Veo's own audio (input 0) is
 *  dropped via explicit -map. When mixVeoPercent > 0 and the clip actually has
 *  an audio stream, Veo's ambient is instead ducked to that volume % and mixed
 *  UNDER the narration (Reign's "keep the TTS and the Veo sound together").
 */
async function renderAnimatedClip(
  runId: string,
  videoPath: string,
  audioPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  tailSilenceSec: number = 0,
  mixVeoPercent: number = 0
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

  // Blend Veo's own ambient UNDER the narration only when asked (voiceover mode
  // + duck>0) AND the clip really carries an audio stream — otherwise amix would
  // error on a missing [0:a]. Falls back to the TTS-only path exactly as before.
  const doMix = mixVeoPercent > 0 && (await hasAudioStream(videoPath));

  const cmd = ffmpeg().input(videoPath).input(audioPath);
  {
    if (doMix) {
      const duck = Math.min(1, Math.max(0, mixVeoPercent / 100)).toFixed(3);
      // normalize=0 keeps our explicit volumes — amix's default divides by the
      // input count, which would halve the narration. duration=longest so a
      // short Veo clip's ambient just stops while the narration carries on.
      const parts = [
        `[0:v]${videoFilter}[vout]`,
        `[0:a]volume=${duck}[veoa]`,
        `[veoa][1:a]amix=inputs=2:duration=longest:normalize=0[amx]`,
      ];
      // Pad the mixed audio to the full clip length (plain apad + the -t cap
      // below). When an animated clip is extended past its narration (Issue #2
      // min-duration), the rest plays out under the ducked ambient / silence
      // instead of an audio stream that ends before the video.
      parts.push(`[amx]apad[aout]`);
      const aout = "aout";
      cmd.complexFilter(parts).outputOptions([
        `-map [vout]`,
        `-map [${aout}]`,
        `-r ${fps}`,
        `-t ${durationSec.toFixed(3)}`,
        "-c:v libx264",
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ]);
    } else {
      cmd.videoFilters(videoFilter);
      // Pad the TTS audio to fill the clip (plain apad + the -t cap below), so an
      // extended animated clip (Issue #2 min-duration) plays its motion out under
      // trailing silence instead of ending when the short narration ends.
      cmd.audioFilters(`apad`);
      cmd.outputOptions([
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
      ]);
    }
  }

  return runFfmpegSave(cmd, outPath, {
    runId,
    label: `img2vid ${path.basename(outPath)} (${doMix ? "mix" : "tts-only"}${durationSec > videoDur + 0.05 ? ", stretch+freeze" : ""})`,
  });
}

/** Simple stream-copy concat (no transitions). */
function concatSimple(runId: string, clipPaths: string[], clipsDir: string, finalPath: string): Promise<void> {
  const listFile = path.join(clipsDir, "concat.txt");
  fs.writeFileSync(listFile, clipPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"), "utf-8");
  const cmd = ffmpeg()
    .input(listFile)
    .inputOptions(["-f concat", "-safe 0"])
    .outputOptions(["-c copy"]);
  return runFfmpegSave(cmd, finalPath, { runId, label: `concat ${clipPaths.length} clips` });
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
          await concatWithCrossfade(runId, chunkClips, chunkPath, fadeDur, fps);
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
    await concatWithCrossfade(runId, current, finalPath, fadeDur, fps);
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
  runId: string,
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

  cmd.complexFilter(filterComplex).outputOptions([
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
  ]);
  return runFfmpegSave(cmd, finalPath, { runId, label: `xfade ${clips.length} clips` });
}

// ───────────────────────────────────────────────────────────────────────────
// Single-shot TTS assembly (one continuous voiceover + Whisper-aligned ranges)
// ───────────────────────────────────────────────────────────────────────────

/** Configure fluent-ffmpeg to honor FFMPEG_PATH (single-shot path runs its own
 *  ffmpeg calls; mirror the setup assembleVideo does inline). */
function ensureFfmpegPaths(): void {
  const ffmpegPath = getSetting("FFMPEG_PATH");
  if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    if (fs.existsSync(ffprobePath)) ffmpeg.setFfprobePath(ffprobePath);
  }
}

/** Per-scene input for single-shot assembly: a visual + its [startMs,endMs]
 *  slice inside the ONE global voiceover (from Whisper word-alignment). */
export interface SingleShotInput {
  scene: Scene;
  /** Poster / Ken-Burns source / static-card image. */
  imagePath: string;
  /** Veo (or stock) clip when this scene moves; null → Ken-Burns the still. */
  videoPath?: string | null;
  startMs: number;
  endMs: number;
  /** Intro stat card etc. — show full-frame, static. */
  staticCard?: boolean;
}

/**
 * Assemble the final video in single-shot mode: render each scene's visual
 * SILENTLY at its Whisper-aligned duration, hard-concat them (NO xfade — even a
 * small crossfade desyncs the visual timeline against the single continuous
 * audio), then mux the one global voiceover over the whole concat. Per-scene
 * render failures are isolated (skipped) like the standard assembler.
 */
export async function assembleSingleShot(
  runId: string,
  inputs: SingleShotInput[],
  globalAudioPath: string,
  outDir: string
): Promise<string> {
  ensureFfmpegPaths();
  const resolution = getSetting("VIDEO_RESOLUTION") || "1920x1080";
  const fps = Number(getSetting("VIDEO_FPS") || "30");
  const assembleConcurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const [w, h] = resolution.split("x").map(Number);

  const clipsDir = path.join(outDir, "clips");
  if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

  log(
    runId,
    "info",
    `Single-shot assembly: ${inputs.length} silent clips → global audio mux (${resolution} @${fps}fps)`,
    { stage: "assemble" }
  );

  const limit = pLimit(assembleConcurrency);
  const settled = await Promise.all(
    inputs.map((item) =>
      limit(async () => {
        const clipPath = path.join(clipsDir, `clip_${String(item.scene.index).padStart(3, "0")}.mp4`);
        const durationSec = Math.max(0.1, (item.endMs - item.startMs) / 1000);
        try {
          if (item.videoPath) {
            await renderSilentClip(runId, item.videoPath, clipPath, w, h, fps, durationSec);
          } else if (item.staticCard) {
            await renderSilentStatic(runId, item.imagePath, clipPath, w, h, fps, durationSec);
          } else {
            const direction: "in" | "out" = Math.random() < 0.5 ? "in" : "out";
            await renderSilentKenBurns(runId, item.imagePath, clipPath, w, h, fps, durationSec, direction);
          }
          log(
            runId,
            "info",
            `Clip #${item.scene.index} silent ${durationSec.toFixed(2)}s (${item.videoPath ? "clip" : "still"}) done`,
            { stage: "assemble" }
          );
          return { path: clipPath, index: item.scene.index };
        } catch (e) {
          log(runId, "warn", `Clip #${item.scene.index} failed to render, skipping: ${(e as Error).message.slice(0, 160)}`, {
            stage: "assemble",
          });
          return null;
        }
      })
    )
  );
  const indexed = settled.filter((c): c is { path: string; index: number } => c !== null);
  if (indexed.length === 0) throw new Error("All scene clips failed to render");
  indexed.sort((a, b) => a.index - b.index);

  // Hard-concat the silent clips (identical params → stream copy), then mux the
  // ONE global voiceover over the whole thing.
  const silentConcat = path.join(outDir, "silent_concat.mp4");
  await concatSimple(runId, indexed.map((c) => c.path), clipsDir, silentConcat);
  log(runId, "info", `Concatenated ${indexed.length} silent clips into one track`, { stage: "assemble" });

  const finalPath = path.join(outDir, "final.mp4");
  await muxAudioOntoVideo(runId, silentConcat, globalAudioPath, finalPath);
  log(runId, "success", `Final video: ${finalPath}`, { stage: "assemble" });
  try { fs.unlinkSync(silentConcat); } catch {}
  return finalPath;
}

/** ONE Veo/stock clip rendered silently, trimmed/stretched/freeze-padded to
 *  `durationSec`. Same policy as renderAnimatedClip (≤1.15× stretch, then
 *  last-frame freeze) but no audio — the voiceover joins later in the mux. */
async function renderSilentClip(
  runId: string,
  videoPath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number
): Promise<void> {
  const videoDur = await probeDuration(videoPath);
  let videoFilter = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  if (durationSec > videoDur + 0.05) {
    const MAX_STRETCH = 1.15;
    const stretchFactor = Math.min(durationSec / videoDur, MAX_STRETCH);
    if (stretchFactor > 1.01) {
      videoFilter = `setpts=${stretchFactor.toFixed(3)}*PTS,fps=${fps},${videoFilter}`;
    }
    const stretchedDur = videoDur * stretchFactor;
    const freezeNeeded = Math.max(0, durationSec - stretchedDur);
    if (freezeNeeded > 0.05) {
      videoFilter = `${videoFilter},tpad=stop_mode=clone:stop_duration=${freezeNeeded.toFixed(3)}`;
    }
  }
  const cmd = ffmpeg()
    .input(videoPath)
    .videoFilters(videoFilter)
    .outputOptions([
      "-an",
      `-r ${fps}`,
      `-t ${durationSec.toFixed(3)}`,
      "-c:v libx264",
      "-preset veryfast",
      "-crf 23",
      "-pix_fmt yuv420p",
      "-movflags +faststart",
    ]);
  return runFfmpegSave(cmd, outPath, { runId, label: `silent-clip ${path.basename(outPath)}` });
}

/** Silent full-frame static still (stat card) at an exact duration. */
function renderSilentStatic(
  runId: string,
  imagePath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number
): Promise<void> {
  const filter = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0e0f13,setsar=1,fps=${fps}`;
  const cmd = ffmpeg()
    .input(imagePath)
    .inputOptions(["-loop 1"])
    .videoFilters(filter)
    .outputOptions([
      "-an",
      `-r ${fps}`,
      `-t ${durationSec.toFixed(3)}`,
      "-c:v libx264",
      "-preset veryfast",
      "-crf 23",
      "-pix_fmt yuv420p",
      "-movflags +faststart",
    ]);
  return runFfmpegSave(cmd, outPath, { runId, label: `silent-static ${path.basename(outPath)}` });
}

/** Silent Ken-Burns still (slow zoom + optional pan) at an exact duration —
 *  same look as renderKenBurnsClip but no audio track. */
function renderSilentKenBurns(
  runId: string,
  imagePath: string,
  outPath: string,
  w: number,
  h: number,
  fps: number,
  durationSec: number,
  direction: "in" | "out"
): Promise<void> {
  const totalFrames = Math.max(2, Math.ceil(durationSec * fps));
  const minZoom = 1.0;
  const maxZoom = 1.18;
  const zoomExpr =
    direction === "in"
      ? `min(${minZoom}+(${maxZoom}-${minZoom})*on/${totalFrames - 1},${maxZoom})`
      : `max(${maxZoom}-(${maxZoom}-${minZoom})*on/${totalFrames - 1},${minZoom})`;
  const panChoice = Math.floor(Math.random() * 5);
  let xExpr = `iw/2-(iw/zoom/2)`;
  let yExpr = `ih/2-(ih/zoom/2)`;
  switch (panChoice) {
    case 1:
      xExpr = `(iw-iw/zoom)*on/${totalFrames - 1}`;
      yExpr = `(ih-ih/zoom)*on/${totalFrames - 1}`;
      break;
    case 2:
      xExpr = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
      yExpr = `(ih-ih/zoom)*on/${totalFrames - 1}`;
      break;
    case 3:
      xExpr = `(iw-iw/zoom)*on/${totalFrames - 1}`;
      yExpr = `(ih-ih/zoom)*(1-on/${totalFrames - 1})`;
      break;
    case 4:
      xExpr = `(iw-iw/zoom)*(1-on/${totalFrames - 1})`;
      yExpr = `(ih-ih/zoom)*(1-on/${totalFrames - 1})`;
      break;
  }
  const filter = `scale=${w * 2}:${h * 2}:flags=lanczos,zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;
  const cmd = ffmpeg()
    .input(imagePath)
    .inputOptions(["-loop 1"])
    .videoFilters(filter)
    .outputOptions([
      "-an",
      `-r ${fps}`,
      `-t ${durationSec.toFixed(3)}`,
      "-c:v libx264",
      "-preset veryfast",
      "-crf 23",
      "-pix_fmt yuv420p",
      "-movflags +faststart",
    ]);
  return runFfmpegSave(cmd, outPath, { runId, label: `silent-kenburns ${path.basename(outPath)}` });
}

/** Mux: copy video from `videoPath`, attach audio from `audioPath`. The
 *  voiceover is the source of truth for length — if the silent video is
 *  slightly shorter (alignment drift / a skipped clip), hold the last frame so
 *  the narration is never cut; otherwise stream-copy the video (fast path). */
async function muxAudioOntoVideo(
  runId: string,
  videoPath: string,
  audioPath: string,
  outPath: string
): Promise<void> {
  const [videoDur, audioDur] = await Promise.all([probeDuration(videoPath), probeDuration(audioPath)]);
  const gap = audioDur - videoDur;
  const cmd = ffmpeg().input(videoPath).input(audioPath);
  const out: string[] = ["-map", "0:v:0", "-map", "1:a:0"];
  if (gap > 0.15) {
    cmd.videoFilters(`tpad=stop_mode=clone:stop_duration=${(gap + 0.5).toFixed(3)}`);
    out.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p");
  } else {
    out.push("-c:v", "copy");
  }
  out.push("-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart");
  cmd.outputOptions(out);
  return runFfmpegSave(cmd, outPath, { runId, label: `mux ${path.basename(outPath)}` });
}

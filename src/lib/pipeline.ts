import path from "node:path";
import fs from "node:fs";
import db from "./db";
import { log } from "./logger";
import { getSetting } from "./settings";
import { getRunDir } from "./run-paths";
import { pLimit } from "./plimit";
import { splitScript } from "./services/scene-split";
import { parseCast, prepareCharacterReferences } from "./services/characters";
import { resolveChannel } from "./channels";
import { synthesizeScene } from "./services/tts";
import { generateImage } from "./services/image-gen";
import { animateScene, pickScenesToAnimate } from "./services/img2vid";
import { extractMatchup, renderStatCard, makeSilentAudio, CARD_DURATION_SEC } from "./services/battle-stats";
import { assembleVideo, extractOrSilentAudio, type AssembleInput } from "./services/video-assemble";
import { acquireStockClipForScene, acquireStockPhotoForScene, pexelsPreflight, type Orientation } from "./services/stock-footage";
import type { TtsResult } from "./services/tts";
import { getKeyCount } from "./services/labs69";
import { syncRunToDrive } from "./services/run-upload";
import { downloadReusedClip } from "./services/reuse";
import { checkCancelled, clearCancelled, CancelledError } from "./cancellation";

const updateRun = db.prepare(
  "UPDATE runs SET status = ?, output_path = ?, updated_at = datetime('now') WHERE id = ?"
);
const getReuseMapStmt = db.prepare("SELECT reuse_map_json FROM runs WHERE id = ?");
const getConfigStmt = db.prepare("SELECT config_json FROM runs WHERE id = ?");

export async function runPipeline(runId: string, script: string) {
  const runDir = getRunDir(runId);
  const audioDir = path.join(runDir, "audio");
  const imgDir = path.join(runDir, "images");
  const animDir = path.join(runDir, "animations");
  const charDir = path.join(runDir, "characters");
  for (const d of [runDir, audioDir, imgDir, animDir, charDir]) fs.mkdirSync(d, { recursive: true });

  try {
    clearCancelled(runId);
    updateRun.run("running", null, runId);
    log(runId, "info", `Pipeline started · folder: ${path.basename(runDir)}`, { stage: "pipeline" });

    // 1. Split script into scenes — and, in parallel, lock character references
    //    (generate/upload + host each character's reference image). The cast is
    //    stored in the run's config_json by the create-run API.
    const cfgRow = getConfigStmt.get(runId) as { config_json: string | null } | undefined;
    const cast = parseCast(cfgRow?.config_json);
    let channelId: string | null = null;
    try {
      channelId = (JSON.parse(cfgRow?.config_json || "{}") as { channelId?: string }).channelId ?? null;
    } catch {
      // malformed config — fall back to global prompts
    }
    const channel = resolveChannel(channelId);
    if (channel.channelName) {
      log(
        runId,
        "info",
        `Channel: ${channel.channelName}${channel.battleCard ? " · stat card on" : ""}`,
        { stage: "pipeline" }
      );
    }
    if (cast.length > 0) {
      log(runId, "info", `Cast: ${cast.map((c) => c.name + (c.isHost ? " (host)" : "")).join(", ")}`, {
        stage: "character",
      });
    }
    const [scenes, characterRefs] = await Promise.all([
      splitScript(runId, script, cast, channel.sceneSplit),
      prepareCharacterReferences(runId, cast, charDir, channel.imageStyle).catch((e) => {
        log(runId, "warn", `Character prep failed: ${(e as Error).message}`, { stage: "character" });
        return {} as Record<string, string>;
      }),
    ]);
    checkCancelled(runId);
    fs.writeFileSync(path.join(runDir, "scenes.json"), JSON.stringify(scenes, null, 2), "utf-8");

    // Reuse map (set when user picked clips from the library on the New Run page).
    // Keys are scene_index as string, values are Drive file IDs. When present
    // for a scene's index, we download the existing clip from Drive instead
    // of running animateScene for that scene — saves credits + time.
    const reuseRow = getReuseMapStmt.get(runId) as { reuse_map_json: string | null } | undefined;
    const reuseMap: Record<string, string> = reuseRow?.reuse_map_json
      ? (JSON.parse(reuseRow.reuse_map_json) as Record<string, string>)
      : {};
    const reuseCount = Object.keys(reuseMap).length;
    if (reuseCount > 0) {
      log(
        runId,
        "info",
        `Reusing ${reuseCount} clip${reuseCount === 1 ? "" : "s"} from Drive library`,
        { stage: "reuse", data: { reuseMap } }
      );
    }

    // 2. Per scene: TTS + Image + (Animation as soon as image is ready) — all
    //    interleaved in a single loop. No "wait for all images then start animations"
    //    phase, which saves ~30–50% of total time.
    //
    // Concurrency limits below are PER KEY. With N 69labs keys configured, the
    // effective parallel job count is (limit × N) — each key has its own 7-image
    // / 5-video cap on the 69labs side.
    const keyCount = Math.max(1, getKeyCount());
    const imageConcurrencyPerKey = Math.max(1, Number(getSetting("IMAGE_CONCURRENCY") || "5"));
    const ttsConcurrencyPerKey = Math.max(1, Number(getSetting("TTS_CONCURRENCY") || "3"));
    const animConcurrencyPerKey = Math.max(1, Number(getSetting("ANIMATION_CONCURRENCY") || "3"));
    const imageConcurrency = imageConcurrencyPerKey * keyCount;
    const ttsConcurrency = ttsConcurrencyPerKey * keyCount;
    const animConcurrency = animConcurrencyPerKey * keyCount;
    const limitImg = pLimit(imageConcurrency);
    const limitTts = pLimit(ttsConcurrency);
    const limitAnim = pLimit(animConcurrency);

    // Which scenes become moving clips (vs stills) — from the channel's
    // clips_source + clips_ratio. Distribution is the global fine-tune setting.
    const distRaw = (getSetting("ANIMATION_DISTRIBUTION") || "first-half").toLowerCase();
    const distribution: "first-half" | "alternating" | "random" | "all" =
      distRaw === "alternating" || distRaw === "random" || distRaw === "all" ? distRaw : "first-half";
    const clipTargets =
      channel.clipsSource !== "none"
        ? pickScenesToAnimate(scenes, channel.clipsRatio, distribution)
        : new Set<number>();

    // Stock (Pexels) options + per-run dedup sets (video & photo libraries differ).
    const stockOrientationRaw = (getSetting("STOCK_FOOTAGE_ORIENTATION") || "landscape").toLowerCase();
    const stockOrientation: Orientation =
      stockOrientationRaw === "portrait" || stockOrientationRaw === "square" ? stockOrientationRaw : "landscape";
    const stockMaxHeight = Math.max(360, Number(getSetting("STOCK_FOOTAGE_MAX_HEIGHT") || "1080"));
    const stockMinDuration = Math.max(1, Number(getSetting("STOCK_FOOTAGE_MIN_DURATION") || "4"));
    const usedVideoIds = new Set<number>();
    const usedPhotoIds = new Set<number>();

    // Fail fast on a missing/invalid Pexels key BEFORE spending any TTS credits.
    if (channel.clipsSource === "stock" || channel.stillsSource === "stock") {
      try {
        await pexelsPreflight(runId);
      } catch (err) {
        throw new Error(`Stock footage needs a valid Pexels API key — ${(err as Error).message}`);
      }
    }

    // Worker-pool concurrency. Bounds peak RAM by capping the number of pending
    // scene closures and plimit queue depth — instead of creating one async
    // closure per scene up front (which on a 1 500-scene run kept ~1 500
    // closures + ~4 500 plimit-queue items alive simultaneously). The plimit
    // limiters still throttle the actual API calls; the worker count just
    // bounds how many SCENE closures live at once.
    const WORKER_COUNT = Math.max(20, keyCount * 5);

    log(
      runId,
      "info",
      `Generating ${scenes.length} scenes. Keys: ${keyCount} · clips: ${
        channel.clipsSource === "none"
          ? "none (stills only)"
          : `${clipTargets.size}/${scenes.length} ${channel.clipsSource} (${distribution})`
      } · stills: ${channel.stillsSource} · voiceover: ${channel.voiceover ? "on" : "off"} · workers=${WORKER_COUNT}`,
      { stage: "pipeline" }
    );

    type SceneResult = (AssembleInput & {
      _imgProviderJobId?: string;
      _imgProvider?: string;
    }) | null;

    const processScene = async (scene: typeof scenes[number]): Promise<SceneResult> => {
      try {
        checkCancelled(runId);
        const pad = String(scene.index).padStart(3, "0");
        const reuseFileId = reuseMap[String(scene.index)];

        // Real subject → real Wikipedia photo (still, never animated).
        const isRealSubject =
          channel.realSubjects &&
          (scene.visual_type === "real_image" || scene.visual_type === "person_overlay");
        // Clip scene → moving footage (AI Veo or real stock), per the ratio.
        const isClip =
          !isRealSubject && channel.clipsSource !== "none" && clipTargets.has(scene.index);

        // ── Produce the visual ──────────────────────────────────────────────
        const makeVisual = async (): Promise<{
          imagePath: string;
          videoPath: string | null;
          jobId?: string;
          provider: string;
        }> => {
          if (isRealSubject) {
            const img = await limitImg(() =>
              generateImage(runId, scene, imgDir, characterRefs, channel.imageStyle, true)
            );
            return { imagePath: img.filePath, videoPath: null, jobId: img.providerJobId, provider: img.provider };
          }

          if (isClip) {
            // Reuse a pre-selected Drive clip if present.
            if (reuseFileId) {
              try {
                const v = await downloadReusedClip(runId, scene, reuseFileId, animDir);
                return { imagePath: v, videoPath: v, provider: "reuse" };
              } catch (e) {
                log(runId, "warn", `reuse #${scene.index} failed: ${(e as Error).message}`, { stage: "reuse" });
              }
            }
            // Real stock video clip (fall back to an AI image if none is found).
            if (channel.clipsSource === "stock") {
              const v = path.join(animDir, `scene_${pad}.mp4`);
              try {
                await limitAnim(() =>
                  acquireStockClipForScene(scene, v, {
                    runId,
                    orientation: stockOrientation,
                    maxHeight: stockMaxHeight,
                    minDuration: stockMinDuration,
                    usedIds: usedVideoIds,
                  })
                );
                return { imagePath: v, videoPath: v, provider: "stock" };
              } catch (e) {
                log(runId, "warn", `Stock clip #${scene.index} unavailable, using AI image: ${(e as Error).message.slice(0, 140)}`, {
                  stage: "animate",
                });
                const img = await limitImg(() =>
                  generateImage(runId, scene, imgDir, characterRefs, channel.imageStyle, channel.realSubjects)
                );
                return { imagePath: img.filePath, videoPath: null, jobId: img.providerJobId, provider: img.provider };
              }
            }
            // AI clip: AI image → Veo (Ken-Burns fallback on failure).
            const img = await limitImg(() =>
              generateImage(runId, scene, imgDir, characterRefs, channel.imageStyle, channel.realSubjects)
            );
            let videoPath: string | null = null;
            if (img.provider !== "wikimedia") {
              try {
                videoPath = await limitAnim(() =>
                  animateScene(runId, scene, img.filePath, animDir, {
                    providerJobId: img.providerJobId,
                    imageProvider: img.provider,
                    motionStyle: channel.animationMotion,
                    // No voiceover + keep-clip-audio → generate Veo WITH its own
                    // sound (otherwise the clip is muted and there's nothing to keep).
                    keepAudio: !channel.voiceover && channel.keepClipAudio,
                  })
                );
              } catch (e) {
                log(runId, "warn", `img2vid #${scene.index} failed, using Ken-Burns: ${(e as Error).message}`, {
                  stage: "animate",
                });
              }
            }
            return { imagePath: img.filePath, videoPath, jobId: img.providerJobId, provider: img.provider };
          }

          // Still scene.
          if (channel.stillsSource === "stock") {
            const p = path.join(imgDir, `scene_${pad}.jpg`);
            try {
              await limitImg(() =>
                acquireStockPhotoForScene(scene, p, {
                  runId,
                  orientation: stockOrientation,
                  maxHeight: stockMaxHeight,
                  usedIds: usedPhotoIds,
                })
              );
              return { imagePath: p, videoPath: null, provider: "stock" };
            } catch (e) {
              log(runId, "warn", `Stock photo #${scene.index} unavailable, using AI image: ${(e as Error).message.slice(0, 140)}`, {
                stage: "image",
              });
              const img = await limitImg(() =>
                generateImage(runId, scene, imgDir, characterRefs, channel.imageStyle, channel.realSubjects)
              );
              return { imagePath: img.filePath, videoPath: null, jobId: img.providerJobId, provider: img.provider };
            }
          }
          const img = await limitImg(() =>
            generateImage(runId, scene, imgDir, characterRefs, channel.imageStyle, channel.realSubjects)
          );
          return { imagePath: img.filePath, videoPath: null, jobId: img.providerJobId, provider: img.provider };
        };

        // Visual + (optional) voiceover in parallel.
        const audioPromise: Promise<TtsResult | null> = channel.voiceover
          ? limitTts(() => synthesizeScene(runId, scene, audioDir))
          : Promise.resolve(null);
        const [visual, ttsAudio] = await Promise.all([makeVisual(), audioPromise]);

        // ── Audio ───────────────────────────────────────────────────────────
        let audio: TtsResult;
        if (ttsAudio) {
          audio = ttsAudio;
        } else {
          // No voiceover: the clip's own sound (or silence), or a fixed-length
          // silent track for stills — so assembly always has an audio file.
          const aOut = path.join(audioDir, `scene_${pad}.mp3`);
          if (visual.videoPath) {
            const dur = await extractOrSilentAudio(
              visual.videoPath,
              aOut,
              channel.keepClipAudio,
              Math.max(2, Number(getSetting("SCENE_DURATION_SECONDS") || "5"))
            );
            audio = { filePath: aOut, durationSec: dur };
          } else {
            const dur = Math.max(2, Number(getSetting("SCENE_DURATION_SECONDS") || "5"));
            await makeSilentAudio(aOut, dur);
            audio = { filePath: aOut, durationSec: dur };
          }
        }

        return {
          scene,
          imagePath: visual.imagePath,
          videoPath: visual.videoPath,
          audio,
          _imgProviderJobId: visual.jobId,
          _imgProvider: visual.provider,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(runId, "error", `Scene #${scene.index} failed: ${msg.slice(0, 200)}`, { stage: "pipeline" });
        return null;
      }
    };

    // Worker pool: each worker pulls the next scene from a shared cursor.
    // Result array is indexed by scene order so downstream assembly is in order.
    const settled: SceneResult[] = new Array(scenes.length).fill(null);
    let nextSceneIdx = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const idx = nextSceneIdx++;
        if (idx >= scenes.length) return;
        settled[idx] = await processScene(scenes[idx]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(WORKER_COUNT, scenes.length) }, () => worker())
    );

    const sceneAssets = settled.filter((x): x is NonNullable<SceneResult> => x !== null);
    const failedCount = scenes.length - sceneAssets.length;

    if (failedCount > 0) {
      const failedPct = (failedCount / scenes.length) * 100;
      log(
        runId,
        failedPct > 25 ? "error" : "warn",
        `${failedCount}/${scenes.length} scenes failed (${failedPct.toFixed(0)}%)`,
        { stage: "pipeline" }
      );
      if (failedPct > 25) {
        throw new Error(`Too many scenes failed: ${failedCount}/${scenes.length}`);
      }
    }
    if (sceneAssets.length === 0) throw new Error("No scenes succeeded");

    checkCancelled(runId);

    // 2c. Battle data mode — prepend an intro "VS" stat card (exact figures via FFmpeg).
    if (channel.battleCard) {
      try {
        const matchup = await extractMatchup(runId, script);
        if (matchup) {
          const [cw, cardH] = (getSetting("VIDEO_RESOLUTION") || "1920x1080").split("x").map(Number);
          const cardPng = path.join(runDir, "stat-card.png");
          const cardAudio = path.join(audioDir, "stat-card.mp3");
          await renderStatCard(matchup, cardPng, cw, cardH);
          await makeSilentAudio(cardAudio, CARD_DURATION_SEC);
          sceneAssets.unshift({
            scene: { index: -1, text: "", visual_prompt: "", duration_hint_sec: CARD_DURATION_SEC },
            imagePath: cardPng,
            videoPath: null,
            audio: { filePath: cardAudio, durationSec: CARD_DURATION_SEC },
            staticCard: true,
          });
          log(
            runId,
            "success",
            `Battle: added VS stat card — ${matchup.left.name} vs ${matchup.right.name}`,
            { stage: "battle" }
          );
        }
      } catch (e) {
        log(runId, "warn", `Battle card skipped: ${(e as Error).message.slice(0, 160)}`, {
          stage: "battle",
        });
      }
    }

    // 3. Assemble final video
    const finalPath = await assembleVideo(runId, sceneAssets, runDir);

    // 4. Drive sync (optional). Runs only when GDRIVE_SYNC_ENABLED=1 + Drive
    //    is connected. Failure here is non-fatal: local files stay intact
    //    and the user can retry from the run page (`/api/runs/<id>/drive`).
    try {
      await syncRunToDrive(runId, sceneAssets, runDir, finalPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Drive sync failed (local files preserved): ${msg}`, { stage: "gdrive" });
    }

    updateRun.run("done", finalPath, runId);
    log(runId, "success", "Pipeline complete", { stage: "pipeline", data: { finalPath } });
  } catch (e) {
    if (e instanceof CancelledError) {
      log(runId, "warn", "Pipeline cancelled by user", { stage: "pipeline" });
      // status 'cancelled' was already set by the API endpoint, don't overwrite
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "error", `Pipeline crashed: ${msg}`, { stage: "pipeline" });
      updateRun.run("error", null, runId);
    }
  }
}

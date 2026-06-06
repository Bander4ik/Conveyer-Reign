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
import { assembleVideo, type AssembleInput } from "./services/video-assemble";
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
      log(runId, "info", `Channel: ${channel.channelName} · data mode: ${channel.dataMode}`, {
        stage: "pipeline",
      });
    }
    if (cast.length > 0) {
      log(runId, "info", `Cast: ${cast.map((c) => c.name + (c.isHost ? " (host)" : "")).join(", ")}`, {
        stage: "character",
      });
    }
    const [scenes, characterRefs] = await Promise.all([
      splitScript(runId, script, cast, channel.sceneSplit, channel.dataMode === "science"),
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

    const animProvider = (getSetting("ANIMATION_PROVIDER") || "69labs").toLowerCase();
    const animRatio = Number(getSetting("ANIMATION_RATIO_PERCENT") || "50");
    const animDistRaw = (getSetting("ANIMATION_DISTRIBUTION") || "first-half").toLowerCase();
    const animDistribution =
      animDistRaw === "alternating" || animDistRaw === "random" || animDistRaw === "all"
        ? (animDistRaw as "alternating" | "random" | "all")
        : "first-half";
    const animTargets =
      animProvider !== "off"
        ? pickScenesToAnimate(scenes, animRatio, animDistribution)
        : new Set<number>();

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
      `Generating ${scenes.length} scenes. Keys: ${keyCount} · Concurrency (per key × keys): TTS=${ttsConcurrencyPerKey}×${keyCount}=${ttsConcurrency}, image=${imageConcurrencyPerKey}×${keyCount}=${imageConcurrency}, anim=${animConcurrencyPerKey}×${keyCount}=${animConcurrency}. Animation: ${animProvider !== "off" ? `${animTargets.size}/${scenes.length} scenes (${animDistribution})` : "off"} · workers=${WORKER_COUNT}`,
      { stage: "pipeline" }
    );

    type SceneResult = (AssembleInput & {
      _imgProviderJobId?: string;
      _imgProvider?: string;
    }) | null;

    const processScene = async (scene: typeof scenes[number]): Promise<SceneResult> => {
      try {
        // Cancellation check before starting new scene tasks.
        // Already-running tasks complete naturally.
        checkCancelled(runId);
        const [audio, image] = await Promise.all([
          limitTts(() => synthesizeScene(runId, scene, audioDir)),
          limitImg(() =>
            generateImage(runId, scene, imgDir, characterRefs, channel.imageStyle, channel.dataMode === "science")
          ),
        ]);

        // 2b. If this scene is in the animation target set, start the img2vid
        //     job RIGHT NOW — no need to wait for other scenes' images.
        //     If the user pre-selected a Drive clip to reuse for this scene,
        //     download it instead of running animateScene (skips Veo entirely).
        let videoPath: string | null = null;
        const reuseFileId = reuseMap[String(scene.index)];
        if (reuseFileId) {
          try {
            videoPath = await downloadReusedClip(runId, scene, reuseFileId, animDir);
          } catch (e) {
            log(
              runId,
              "warn",
              `reuse #${scene.index} failed, falling back to live img2vid: ${(e as Error).message}`,
              { stage: "reuse" }
            );
          }
        }
        if (!videoPath && animTargets.has(scene.index) && image.provider !== "wikimedia") {
          try {
            videoPath = await limitAnim(() =>
              animateScene(runId, scene, image.filePath, animDir, {
                providerJobId: image.providerJobId,
                imageProvider: image.provider,
                motionStyle: channel.animationMotion,
              })
            );
          } catch (e) {
            log(
              runId,
              "warn",
              `img2vid #${scene.index} failed, falling back to Ken-Burns: ${(e as Error).message}`,
              { stage: "animate" }
            );
          }
        }

        return {
          scene,
          imagePath: image.filePath,
          videoPath,
          audio,
          _imgProviderJobId: image.providerJobId,
          _imgProvider: image.provider,
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
    if (channel.dataMode === "battle") {
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

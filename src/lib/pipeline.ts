import path from "node:path";
import fs from "node:fs";
import db from "./db";
import { log } from "./logger";
import { getSetting } from "./settings";
import { getRunDir } from "./run-paths";
import { pLimit } from "./plimit";
import { splitScript, extractStoryBible } from "./services/scene-split";
import { parseCast, prepareCharacterReferences, type CharacterSpec } from "./services/characters";
import { uploadPublicImage } from "./services/image-host";
import { resolveChannel } from "./channels";
import { synthesizeScene } from "./services/tts";
import { generateImage } from "./services/image-gen";
import { animateScene, pickScenesToAnimate } from "./services/img2vid";
import { extractMatchup, renderStatCard, makeSilentAudio, CARD_DURATION_SEC } from "./services/battle-stats";
import { assembleVideo, assembleSingleShot, extractOrSilentAudio, extractLastFrame, type AssembleInput, type SingleShotInput } from "./services/video-assemble";
import { synthesizeAndAlign } from "./services/tts-align";
import { pexelsPreflight } from "./services/stock-footage";
import { acquireScoredFootage } from "./services/visual-source";
import type { TtsResult } from "./services/tts";
import { getKeyCount } from "./services/labs69";
import { syncRunToDrive } from "./services/run-upload";
import { generateThumbnails } from "./services/thumbnail";
import { downloadReusedClip } from "./services/reuse";
import { checkCancelled, clearCancelled, CancelledError } from "./cancellation";

const updateRun = db.prepare(
  "UPDATE runs SET status = ?, output_path = ?, updated_at = datetime('now') WHERE id = ?"
);
const getReuseMapStmt = db.prepare("SELECT reuse_map_json FROM runs WHERE id = ?");
const getConfigStmt = db.prepare("SELECT config_json FROM runs WHERE id = ?");
const getTitleStmt = db.prepare("SELECT title FROM runs WHERE id = ?");

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
    const manualCast = parseCast(cfgRow?.config_json);
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
    // Single-shot voiceover mode: ONE continuous narration for the whole script,
    // word-aligned to scene boundaries via Groq Whisper (fluid, no per-scene
    // "breaths"). FAIL FAST when the key is missing so it's unmistakable the mode
    // needs it — never silently fall back to per-scene while the user assumes
    // single-shot is running.
    // Gated on channel.voiceover: single-shot IS a voiceover mode, so a channel
    // with voiceover OFF must stay silent — the global TTS_MODE never forces
    // narration onto a no-voiceover channel.
    const singleShot =
      channel.voiceover && (getSetting("TTS_MODE") || "per-scene").toLowerCase() === "single-shot";
    if (singleShot && !getSetting("GROQ_API_KEY").trim()) {
      throw new Error(
        "Single-shot voiceover (TTS_MODE=single-shot) needs GROQ_API_KEY — paste it in Settings (free key at console.groq.com), or set TTS_MODE back to per-scene."
      );
    }
    if (singleShot) {
      log(runId, "info", "TTS mode: single-shot — one continuous voiceover + Whisper word-alignment to scene boundaries", {
        stage: "pipeline",
      });
    }
    // Continuity auto-cast + shared world: extract a "story bible" from the
    // script (one LLM call). When the user defined NO characters manually, the
    // recurring subjects it finds (e.g. the two battling animals) become the
    // cast — so they get a locked reference image and stay identical across the
    // whole video, reusing the existing character pipeline. The world block is
    // appended to every image prompt so the environment/lighting stays constant.
    // Best-effort: an empty bible just means no auto-cast / no world block.
    const bible = channel.continuity ? await extractStoryBible(runId, script) : { world: "", subjects: [] };
    const autoCast: CharacterSpec[] = bible.subjects.map((s, i) => ({
      id: `auto${i}`,
      name: s.name,
      source: "describe" as const,
      description: s.description,
      isHost: false,
    }));
    // Manual cast always wins; auto-cast only fills in when the user gave none.
    const cast: CharacterSpec[] = manualCast.length > 0 ? manualCast : autoCast;
    const worldStyle = bible.world.trim() || undefined;
    if (cast.length > 0) {
      log(
        runId,
        "info",
        `Cast: ${cast.map((c) => c.name + (c.isHost ? " (host)" : "")).join(", ")}${
          manualCast.length === 0 && autoCast.length > 0 ? " (auto from script)" : ""
        }`,
        { stage: "character" }
      );
    }

    const [scenes, characterRefs] = await Promise.all([
      splitScript(runId, script, cast, channel.sceneSplit, channel.continuity),
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

    // Veo's OWN ambient sound mixed UNDER the TTS narration (Reign's request:
    // keep the voiceover AND the Veo audio together). Only when voiceover is
    // ON; 0 = disabled (TTS only, the old behavior). Drives both (a) generating
    // Veo un-muted below and (b) the assembly-time duck+mix.
    const veoDuckPercent = channel.voiceover
      ? Math.min(100, Math.max(0, Number(getSetting("VEO_DUCK_PERCENT") || "30")))
      : 0;

    // Real-footage relevance system (multi-source search + Gemini Vision scoring).
    // One run-wide dedup set of namespaced ids ("pexels:123", "wikimedia:Foo"…).
    const usedFootageIds = new Set<string>();
    const footageDurSec = Math.max(
      Number(getSetting("STOCK_FOOTAGE_MIN_DURATION") || "4"),
      Number(getSetting("SCENE_DURATION_SECONDS") || "5")
    );
    // One-line topic of the whole video — anchors relevance scoring to context.
    const videoContext = script.replace(/\s+/g, " ").trim().slice(0, 400);

    // Fail fast when the kie.ai backend is selected but its key is missing —
    // BEFORE spending credits anywhere.
    {
      const usesKie = ["IMAGE_PROVIDER", "ANIMATION_PROVIDER", "TTS_PROVIDER"].some(
        (k) => (getSetting(k as "IMAGE_PROVIDER") || "").toLowerCase() === "kie"
      );
      if (usesKie && !getSetting("KIE_API_KEY").trim()) {
        throw new Error(
          "AI provider is set to kie.ai but KIE_API_KEY is empty — add the key in Settings (get one at kie.ai → API Keys), or switch the AI provider back to 69labs."
        );
      }
    }

    // Fail fast on a missing/invalid Pexels key BEFORE spending any TTS credits —
    // but only when a real-footage channel actually uses Pexels. The keyless
    // sources (Openverse / Wikimedia / Internet Archive) need no key.
    if (channel.clipsSource === "stock" || channel.stillsSource === "stock") {
      const sources = (getSetting("FOOTAGE_SOURCES") || "pexels,openverse,wikimedia,archive").toLowerCase();
      if (sources.includes("pexels")) {
        try {
          await pexelsPreflight(runId);
        } catch (err) {
          throw new Error(`Real footage with Pexels needs a valid Pexels API key — ${(err as Error).message}`);
        }
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

    // ── Continuity: group scenes into "shots" (same subjects/place) ──────────
    // The FIRST scene of each shot is the ANCHOR; once its frame is generated it
    // is uploaded and reused as a reference for the rest of the shot, so the look
    // stays consistent. A shot also re-anchors every MAX_SHOT_SCENES so a
    // mistagged long run can't collapse the whole video to one frame.
    const shotIdByIndex = new Map<number, number>();
    const shotAnchorIndex = new Map<number, number>();
    const anchorResolve = new Map<number, (u: string | null) => void>();
    const anchorPromise = new Map<number, Promise<string | null>>();
    // Cross-shot carry-over: the URL of the MOST RECENTLY published shot anchor.
    // A new shot's anchor uses it as a soft reference so the look (and the locked
    // subjects) carries across the CUT, not just within a shot. Best-effort and
    // non-blocking — just a hint read at generation time, so it never adds a
    // promise that could hang the worker pool. Subject identity is still
    // guaranteed by the per-scene character references; this mainly steadies the
    // environment/lighting across shot boundaries.
    let lastAnchorUrl: string | null = null;

    // Motion continuity: chain consecutive AI-animated clips in a shot so each
    // clip CONTINUES the previous clip's final frame (the action flows on instead
    // of restarting). Per animated scene we record its motion-predecessor index,
    // plus a promise the predecessor resolves with its last frame {url, localPath}.
    type ChainFrame = { url: string; localPath: string };
    const motionPredIndex = new Map<number, number>();
    const frameResolve = new Map<number, (f: ChainFrame | null) => void>();
    const framePromise = new Map<number, Promise<ChainFrame | null>>();
    if (channel.continuity) {
      const MAX_SHOT_SCENES = 6;
      // Cap on how many AI clips chain back-to-back. Chained clips MUST generate
      // sequentially (each continues the previous clip's final frame), so an
      // unbounded chain would serialize the whole run. 12 ≈ a long continuous
      // beat before an unavoidable motion reset; a real scene change (new_shot)
      // resets it sooner. Independent shots still animate in parallel, so total
      // throughput is unaffected as long as there are several shots in flight.
      const MAX_CHAIN = 12;
      // Only an AI image can anchor or chain. Stock/real scenes never publish or
      // wait for an anchor frame.
      const usesAiImage = (s: typeof scenes[number]): boolean => {
        const isRealSubject =
          channel.realSubjects &&
          (s.visual_type === "real_image" || s.visual_type === "person_overlay");
        const isClip = !isRealSubject && channel.clipsSource !== "none" && clipTargets.has(s.index);
        return (
          (isClip && channel.clipsSource === "ai") ||
          (!isClip && !isRealSubject && channel.stillsSource === "ai")
        );
      };
      // A scene that becomes a MOVING AI clip — only these produce a final frame
      // a following clip can continue from (stock/real/still scenes don't).
      const isAnimatedAiClip = (s: typeof scenes[number]): boolean => {
        const isRealSubject =
          channel.realSubjects &&
          (s.visual_type === "real_image" || s.visual_type === "person_overlay");
        const isClip = !isRealSubject && channel.clipsSource !== "none" && clipTargets.has(s.index);
        return isClip && channel.clipsSource === "ai";
      };
      let shotId = -1;
      let since = 0;
      // The motion chain runs INDEPENDENTLY of the 6-scene image-anchor window:
      // it breaks only on a real scene change (new_shot), a non-animated scene,
      // or the MAX_CHAIN safety cap — so the action keeps flowing across a whole
      // real scene even when that scene spans several anchor windows (Reign:
      // "cut only when the scene actually changes").
      let prevAnimatedClip = -1;
      let chainLen = 0;
      for (const s of scenes) {
        if (shotId < 0 || s.new_shot || since >= MAX_SHOT_SCENES) {
          shotId++;
          since = 0;
          shotAnchorIndex.set(shotId, s.index);
          // Only create the anchor promise when the anchor is an AI image. For a
          // stock/real anchor, AI followers in the shot then short-circuit
          // (awaitAnchor → null) instead of burning the 120s cap waiting for a
          // frame that will never be published.
          if (usesAiImage(s)) {
            anchorPromise.set(shotId, new Promise<string | null>((res) => anchorResolve.set(shotId, res)));
          }
        }
        shotIdByIndex.set(s.index, shotId);
        // A real scene change breaks the motion flow (a hard cut is intended).
        if (s.new_shot) { prevAnimatedClip = -1; chainLen = 0; }
        if (isAnimatedAiClip(s)) {
          if (prevAnimatedClip >= 0 && chainLen < MAX_CHAIN) {
            // Continue the previous clip's motion (link to its last frame).
            motionPredIndex.set(s.index, prevAnimatedClip);
            if (!framePromise.has(prevAnimatedClip)) {
              framePromise.set(
                prevAnimatedClip,
                new Promise<ChainFrame | null>((res) => frameResolve.set(prevAnimatedClip, res))
              );
            }
            chainLen++;
          } else {
            // Chain head: a fresh generation (first clip after a cut, or the cap
            // was hit). Its look still matches the shot via the image anchor.
            chainLen = 1;
          }
          prevAnimatedClip = s.index;
        } else {
          // A still / stock / real-photo scene interrupts the visible motion.
          prevAnimatedClip = -1;
          chainLen = 0;
        }
        since++;
      }
      log(runId, "info", `Continuity ON — ${shotAnchorIndex.size} shot(s) across ${scenes.length} scenes`, {
        stage: "pipeline",
      });
    }
    // Non-anchor scenes wait for their shot's anchor frame (cap the wait so a
    // failed anchor never hangs the run — they just generate fresh).
    const awaitAnchor = (sid: number): Promise<string | null> => {
      const p = anchorPromise.get(sid);
      if (!p) return Promise.resolve(null);
      // Race the anchor against a 120s cap, but CLEAR the timer once the anchor
      // settles so long runs don't leave one live timer per waiting scene.
      return new Promise<string | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 120_000);
        p.then(
          (u) => { clearTimeout(t); resolve(u); },
          () => { clearTimeout(t); resolve(null); }
        );
      });
    };

    // Motion continuity: a chained clip waits for its predecessor's last frame.
    // Same 120s cap + timer-clear as awaitAnchor, so a slow/failed predecessor
    // never hangs the run — the scene just generates a fresh still instead.
    const awaitFrame = (predIndex: number): Promise<ChainFrame | null> => {
      const p = framePromise.get(predIndex);
      if (!p) return Promise.resolve(null);
      return new Promise<ChainFrame | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 120_000);
        p.then(
          (f) => { clearTimeout(t); resolve(f); },
          () => { clearTimeout(t); resolve(null); }
        );
      });
    };

    const processScene = async (scene: typeof scenes[number]): Promise<SceneResult> => {
      const shotId = channel.continuity ? shotIdByIndex.get(scene.index) ?? -1 : -1;
      const isAnchor = channel.continuity && shotAnchorIndex.get(shotId) === scene.index;
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

        // Continuity: an AI-image scene that is NOT its shot's anchor references
        // the anchor's frame so the subjects/look stay the same across the shot.
        const usesAiImage =
          (isClip && channel.clipsSource === "ai") ||
          (!isClip && !isRealSubject && channel.stillsSource === "ai");
        // Motion continuity: if this clip continues a previous clip, wait for that
        // clip's LAST frame and animate FROM it (the action flows on). We only
        // fall back to the still-image anchor reference when NOT chaining motion
        // (a chained scene skips image generation entirely).
        let chainFrame: ChainFrame | null = null;
        if (channel.continuity && motionPredIndex.has(scene.index)) {
          chainFrame = await awaitFrame(motionPredIndex.get(scene.index)!);
        }
        let chainRefUrl: string | undefined;
        if (channel.continuity && usesAiImage && !isAnchor && !chainFrame) {
          chainRefUrl = (await awaitAnchor(shotId)) ?? undefined;
        } else if (channel.continuity && usesAiImage && isAnchor && !chainFrame && lastAnchorUrl) {
          // Cross-shot carry-over: a new shot's anchor matches the previous shot's
          // anchor so the look continues across the cut. Non-blocking hint.
          chainRefUrl = lastAnchorUrl;
        }

        // ── Produce the visual ──────────────────────────────────────────────
        const makeVisual = async (): Promise<{
          imagePath: string;
          videoPath: string | null;
          jobId?: string;
          provider: string;
        }> => {
          if (isRealSubject) {
            const img = await limitImg(() =>
              generateImage(runId, scene, imgDir, characterRefs, channel.imageStyle, true, undefined, worldStyle)
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
            // Real footage: search every source + Gemini Vision picks the clip
            // that best matches the scene; AI fallback if none clears the bar.
            if (channel.clipsSource === "stock") {
              const v = path.join(animDir, `scene_${pad}.mp4`);
              const found = await limitAnim(() =>
                acquireScoredFootage(scene, v, usedFootageIds, {
                  runId,
                  want: "video",
                  durSec: footageDurSec,
                  videoContext,
                })
              );
              if (found) return { imagePath: v, videoPath: v, provider: found.provider };
              log(runId, "warn", `No relevant real clip for #${scene.index} — using AI image instead`, {
                stage: "animate",
              });
              const img = await limitImg(() =>
                generateImage(runId, scene, imgDir, characterRefs, channel.imageStyle, channel.realSubjects, undefined, worldStyle)
              );
              return { imagePath: img.filePath, videoPath: null, jobId: img.providerJobId, provider: img.provider };
            }
            // AI clip: when CHAINING, animate straight from the previous clip's
            // last frame — NO new still is generated, so the motion continues
            // instead of restarting. Otherwise generate a fresh still (look-matched
            // to the shot anchor) and animate that. Ken-Burns fallback either way.
            let posterPath: string;
            let imgJobId: string | undefined;
            let imgProvider: string;
            if (chainFrame) {
              // The predecessor's final frame is BOTH the Veo start (via URL below)
              // and the local poster / Ken-Burns fallback for this scene.
              posterPath = chainFrame.localPath;
              imgProvider = "chain";
            } else {
              const img = await limitImg(() =>
                generateImage(runId, scene, imgDir, characterRefs, channel.imageStyle, channel.realSubjects, chainRefUrl, worldStyle)
              );
              posterPath = img.filePath;
              imgJobId = img.providerJobId;
              imgProvider = img.provider;
            }
            let videoPath: string | null = null;
            if (imgProvider !== "wikimedia") {
              try {
                videoPath = await limitAnim(() =>
                  animateScene(runId, scene, posterPath, animDir, {
                    providerJobId: imgJobId,
                    imageProvider: imgProvider,
                    motionStyle: channel.animationMotion,
                    // Generate Veo WITH its own sound whenever something downstream
                    // will USE it: (a) no-voiceover + keep-clip-audio (the clip's
                    // audio IS the track), or (b) voiceover + duck>0 (we mix the
                    // ambient UNDER the narration). Otherwise mute it.
                    keepAudio: (!channel.voiceover && channel.keepClipAudio) || veoDuckPercent > 0,
                    // Motion continuity: animate FROM the previous clip's final frame.
                    startFrameUrl: chainFrame?.url,
                  })
                );
              } catch (e) {
                log(runId, "warn", `img2vid #${scene.index} failed, using Ken-Burns: ${(e as Error).message}`, {
                  stage: "animate",
                });
              }
            }
            return { imagePath: posterPath, videoPath, jobId: imgJobId, provider: imgProvider };
          }

          // Still scene from real footage: search every source + Gemini Vision
          // picks the photo that best matches the scene; AI fallback otherwise.
          if (channel.stillsSource === "stock") {
            const p = path.join(imgDir, `scene_${pad}.jpg`);
            const found = await limitImg(() =>
              acquireScoredFootage(scene, p, usedFootageIds, {
                runId,
                want: "image",
                videoContext,
              })
            );
            if (found) return { imagePath: p, videoPath: null, provider: found.provider };
            log(runId, "warn", `No relevant real photo for #${scene.index} — using AI image instead`, {
              stage: "image",
            });
            const img = await limitImg(() =>
              generateImage(runId, scene, imgDir, characterRefs, channel.imageStyle, channel.realSubjects, undefined, worldStyle)
            );
            return { imagePath: img.filePath, videoPath: null, jobId: img.providerJobId, provider: img.provider };
          }
          const img = await limitImg(() =>
            generateImage(runId, scene, imgDir, characterRefs, channel.imageStyle, channel.realSubjects, chainRefUrl, worldStyle)
          );
          return { imagePath: img.filePath, videoPath: null, jobId: img.providerJobId, provider: img.provider };
        };

        // Visual + (optional) voiceover in parallel.
        const audioPromise: Promise<TtsResult | null> = (channel.voiceover && !singleShot)
          ? limitTts(() => synthesizeScene(runId, scene, audioDir, channel.voiceId))
          : Promise.resolve(null);
        // Defensive: if makeVisual() rejects, Promise.all short-circuits; keep a
        // no-op catch so a later TTS rejection can never surface as an
        // unhandledRejection (which, under Node's default policy, can crash the
        // whole process on a long flaky run).
        audioPromise.catch(() => {});
        const [visual, ttsAudio] = await Promise.all([makeVisual(), audioPromise]);

        // Continuity: publish this shot's anchor frame so the rest of the shot
        // can match it (upload to a public URL the image model can fetch).
        if (isAnchor && channel.continuity && usesAiImage && visual.imagePath) {
          try {
            const url = await uploadPublicImage(visual.imagePath);
            // Carry this anchor across the next shot cut (best-effort hint).
            lastAnchorUrl = url;
            anchorResolve.get(shotId)?.(url);
          } catch {
            anchorResolve.get(shotId)?.(null);
          }
        }

        // Motion continuity: publish THIS clip's LAST frame so the next clip in
        // the shot continues from it. Only runs when a successor actually awaits
        // it (frameResolve set in the pre-pass). No clip → resolve null so the
        // successor falls back to a fresh still instead of waiting out the cap.
        if (channel.continuity && frameResolve.has(scene.index)) {
          if (visual.videoPath) {
            try {
              const framePng = path.join(animDir, `lastframe_${pad}.png`);
              await extractLastFrame(visual.videoPath, framePng);
              const url = await uploadPublicImage(framePng);
              frameResolve.get(scene.index)?.({ url, localPath: framePng });
            } catch (e) {
              log(runId, "warn", `last-frame chain #${scene.index} failed (next clip generates fresh): ${(e as Error).message.slice(0, 140)}`, {
                stage: "animate",
              });
              frameResolve.get(scene.index)?.(null);
            }
          } else {
            frameResolve.get(scene.index)?.(null);
          }
        }

        // ── Audio ───────────────────────────────────────────────────────────
        let audio: TtsResult;
        if (ttsAudio) {
          audio = ttsAudio;
        } else if (singleShot) {
          // Single-shot: per-scene audio is unused — the ONE global voiceover is
          // muxed over the whole video at assembly. Placeholder keeps the shape.
          audio = { filePath: "", durationSec: 0 };
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
          // Mix Veo's ambient under the narration at assembly — only when there's
          // a real moving clip, voiceover is on, and ducking is enabled.
          mixVeoPercent: visual.videoPath && veoDuckPercent > 0 ? veoDuckPercent : undefined,
          _imgProviderJobId: visual.jobId,
          _imgProvider: visual.provider,
        };
      } catch (e) {
        // A user cancel must win over the per-scene "failed → null" path: if we
        // swallowed it, cancelled scenes would count toward the 25% fail-gate and
        // the run would be mislabelled "error" instead of "cancelled". Re-throw so
        // it propagates out of the worker pool to the outer CancelledError handler.
        if (e instanceof CancelledError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        log(runId, "error", `Scene #${scene.index} failed: ${msg.slice(0, 200)}`, { stage: "pipeline" });
        return null;
      } finally {
        // Safety: never leave the rest of a shot waiting on a failed/non-AI anchor
        // or a failed/cancelled predecessor frame (resolving twice is a no-op —
        // a real value set above already won).
        if (isAnchor) anchorResolve.get(shotId)?.(null);
        frameResolve.get(scene.index)?.(null);
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

    // 3. Assemble final video.
    let finalPath: string;
    if (singleShot) {
      // ONE continuous voiceover for the whole script (synthesised once), with
      // each scene's visual shown for its Whisper-aligned slice → fluid narration
      // with no per-scene audio seams. (The battle stat card and the per-scene
      // Veo-audio mix don't apply in this mode.)
      const aligned = await synthesizeAndAlign(runId, scenes, audioDir, { voiceOverride: channel.voiceId });
      const rangeByIdx = new Map(aligned.ranges.map((r) => [r.sceneIdx, r] as const));
      const assetByIdx = new Map(sceneAssets.map((a) => [a.scene.index, a] as const));
      // Fill EVERY scene's slice so the visual timeline stays in lockstep with the
      // continuous audio — a failed visual holds the last good still over its slice.
      let lastGoodImage = sceneAssets[0].imagePath;
      const ssInputs: SingleShotInput[] = [];
      for (const s of scenes) {
        const r = rangeByIdx.get(s.index);
        if (!r) continue;
        const a = assetByIdx.get(s.index);
        if (a) {
          lastGoodImage = a.imagePath;
          ssInputs.push({
            scene: s,
            imagePath: a.imagePath,
            videoPath: a.videoPath,
            staticCard: a.staticCard,
            startMs: r.startMs,
            endMs: r.endMs,
          });
        } else {
          ssInputs.push({ scene: s, imagePath: lastGoodImage, videoPath: null, startMs: r.startMs, endMs: r.endMs });
        }
      }
      finalPath = await assembleSingleShot(runId, ssInputs, aligned.filePath, runDir);
    } else {
      // 2c. Battle data mode — prepend an intro "VS" stat card (per-scene path only).
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

      finalPath = await assembleVideo(runId, sceneAssets, runDir);
    }

    // 3b. Auto thumbnails (best-effort). The channel's master prompt + the title
    //     + the whole script go to the LLM, which writes a per-video thumbnail
    //     prompt; the image provider then makes THUMBNAIL_COUNT options. Never
    //     fails the run — the video is already done.
    if (channel.thumbnail && channel.thumbnailPrompt.trim()) {
      try {
        const titleRow = getTitleStmt.get(runId) as { title?: string | null } | undefined;
        await generateThumbnails({
          runId,
          title: titleRow?.title ?? "",
          script,
          masterPrompt: channel.thumbnailPrompt,
          runDir,
          count: Number(getSetting("THUMBNAIL_COUNT") || "4"),
        });
      } catch (e) {
        log(runId, "warn", `Thumbnails failed (non-fatal): ${(e as Error).message.slice(0, 140)}`, { stage: "thumbnail" });
      }
    }

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

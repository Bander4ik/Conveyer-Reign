import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { getPrompt } from "../prompts";
import { log } from "../logger";
import type { Scene } from "./scene-split";
import { createImageJob, pollJob, downloadJob, cancelJob, releaseJob } from "./labs69";
import { createKieTask, pollKieTask, downloadKieFile, kieImageModel, kieResolution } from "./kie";
import { MAX_CHARACTER_REFS } from "./characters";
import { tryRealImage } from "./wiki-image";
import { verifyFrame } from "./vision-qc";
import { shotTypeClause } from "./shot-grammar";

export interface ImageResult {
  /** Path to the png file. */
  filePath: string;
  /** Provider's job id (if supported) — used to chain into img2vid without re-uploading. */
  providerJobId?: string;
  /** Which provider made the image. */
  provider: string;
}

/**
 * Generates one illustration for a scene.
 * Supports 69labs (default), Replicate (Flux), OpenAI Images, fal.ai.
 */
export async function generateImage(
  runId: string,
  scene: Scene,
  outDir: string,
  characterRefs?: Record<string, string>,
  imageStyle?: string,
  allowReal = true,
  /** Continuity: a public image URL of the shot's anchor frame (or the previous
   *  shot's anchor, carried across a cut). When set, this scene is generated to
   *  match it (same subjects/look, different angle). */
  chainRefUrl?: string,
  /** Story-bible world block: a shared setting/lighting/palette/camera string
   *  appended to EVERY scene so the environment stays constant run-wide. */
  worldStyle?: string
): Promise<ImageResult> {
  const provider = (getSetting("IMAGE_PROVIDER") || "69labs").toLowerCase();
  const styleSuffix = imageStyle ?? getPrompt("image_prompt");

  // Character consistency: if this scene features cast members whose reference
  // image was prepared, collect those reference URLs (capped) and instruct the
  // model to match them. The image model (nano-banana) keeps the same look.
  const sceneChars = Array.isArray(scene.characters) ? scene.characters : [];
  const refUrls: string[] = [];
  const refNames: string[] = [];
  if (characterRefs && sceneChars.length > 0) {
    for (const name of sceneChars) {
      const url = characterRefs[name];
      if (url && !refUrls.includes(url)) {
        refUrls.push(url);
        refNames.push(name);
      }
      if (refUrls.length >= MAX_CHARACTER_REFS) break;
    }
  }

  // Visual continuity: when a shot anchor is provided, instruct the model to keep
  // the SAME subjects/look as the reference and only change angle + action.
  const continuityClause = chainRefUrl
    ? ` IMPORTANT: this shot CONTINUES the scene shown in the LAST reference image — keep the SAME animals/subjects with the SAME appearance, the SAME environment and lighting; change ONLY the camera angle and the action described above. Photorealistic, perfectly consistent with that reference.`
    : "";
  // Story-bible shared world: appended to every scene so the biome/lighting/
  // palette/camera stay constant across the whole video, not just within a shot.
  const worldClause = worldStyle?.trim()
    ? ` Setting (keep CONSISTENT across the whole video): ${worldStyle.trim()}.`
    : "";
  // Subject-lock clause — subject-agnostic so it locks ANIMALS (species, markings,
  // build) as well as people (face, hair, clothing).
  const subjectClause =
    refUrls.length > 0
      ? ` The subject(s) ${refNames
          .map((n) => `"${n}"`)
          .join(", ")} must match the same subject(s) shown in the provided reference image(s) — keep the same species, markings, coloration, build and proportions (and for any person, the same face, hair and clothing) consistent.`
      : "";
  // Shot-grammar framing (macro / close / wide / …) goes BEFORE the global style
  // suffix so it shapes the composition. Empty string when shot grammar is off,
  // so the prompt is byte-identical to before. Only the still framing — chained
  // followers skip image generation, so this renders for anchors / chain-heads.
  const shotClause = shotTypeClause(scene.shot_type);
  const finalPrompt = `${scene.visual_prompt}, ${shotClause}${styleSuffix}.${worldClause}${subjectClause}${continuityClause}`;
  // Anchor ref goes LAST so the "LAST reference image" wording above points at it.
  const allRefs = chainRefUrl ? [...refUrls, chainRefUrl] : refUrls;
  const fileName = `scene_${String(scene.index).padStart(3, "0")}.png`;
  const filePath = path.join(outDir, fileName);

  // Per-scene visual routing (set by the scene-split prompt): pull a real photo
  // instead of generating it, for real subjects / real people.
  const vtype = allowReal ? (scene.visual_type ?? "generated") : "generated";
  if (vtype === "real_image" && scene.real_image_query) {
    const ok = await tryRealImage(runId, scene.real_image_query, filePath, "");
    if (ok) {
      log(runId, "success", `Image saved (real photo): ${fileName}`, { stage: "image" });
      return { filePath, provider: "wikimedia" };
    }
  } else if (vtype === "person_overlay" && scene.wikipedia_lookup) {
    const ok = await tryRealImage(runId, scene.wikipedia_lookup, filePath, scene.person_name || "");
    if (ok) {
      log(runId, "success", `Image saved (real person): ${fileName}`, { stage: "image" });
      return { filePath, provider: "wikimedia" };
    }
  } else if (vtype !== "generated") {
    log(runId, "warn", `Scene #${scene.index} tagged "${vtype}" but its lookup query is empty — generating with AI instead`, {
      stage: "image",
    });
  }

  log(
    runId,
    "info",
    `Image scene #${scene.index} (${provider})${refUrls.length ? ` · refs: ${refNames.join(", ")}` : ""}`,
    {
      stage: "image",
      data: { provider, prompt: finalPrompt.slice(0, 120), refs: refUrls.length },
    }
  );

  if (refUrls.length > 0 && provider !== "69labs" && provider !== "kie") {
    log(runId, "warn", `Character references are only wired for the 69labs image provider — ignored for "${provider}"`, {
      stage: "image",
    });
  }

  // Produce ONE AI image into `outFile`; returns the 69labs job id (used to chain
  // into img2vid without re-uploading) when applicable. Mirrors the original
  // per-provider dispatch so behavior is unchanged when QC is off.
  const produceAiImage = async (outFile: string): Promise<string | undefined> => {
    if (provider === "69labs") return await labs69Image(runId, finalPrompt, outFile, allRefs);
    if (provider === "kie") {
      await kieImage(runId, finalPrompt, outFile, allRefs);
      return undefined;
    }
    if (provider === "replicate") await replicateImage(finalPrompt, outFile);
    else if (provider === "openai") await openaiImage(finalPrompt, outFile);
    else if (provider === "fal") await falImage(finalPrompt, outFile);
    else throw new Error(`Unknown image provider: ${provider}`);
    return undefined;
  };

  // Vision QC gate: verify the generated frame actually shows the intended
  // subject (e.g. a leopard cub, not a bear); regenerate on a hard miss and keep
  // the best-scoring attempt. Anchor frames are generated/QC'd before they're
  // published, so a shot's followers match a verified frame for free. Only for
  // AI-generated images (real-media routing is disabled in AI-only mode anyway).
  const qcOn = getSetting("IMAGE_QC") === "1" && vtype === "generated";

  const jobId0 = await produceAiImage(filePath);
  if (!qcOn) {
    log(runId, "success", `Image saved: ${fileName}`, { stage: "image" });
    return { filePath, providerJobId: jobId0, provider };
  }

  // Hierarchical scoring: subject correctness is a HARD FLOOR (a wrong species can
  // never pass, regardless of how cinematic it looks); cinematic quality is a
  // weighted SECONDARY score. During calibration (IMAGE_QC_CINEMA=log) cinema is
  // only OBSERVED/logged — the gate fires on the subject floor alone — so we can
  // collect cinemaScore distributions before using it as a gate ("weighted").
  const qcMode = (getSetting("IMAGE_QC_CINEMA") || "log").toLowerCase(); // "log" | "weighted"
  const subjFloor = Number(getSetting("IMAGE_QC_SUBJECT_FLOOR") || "55");
  const finalBar = Number(getSetting("IMAGE_QC_THRESHOLD") || "60");
  const wSubject = Number(getSetting("IMAGE_QC_W_SUBJECT") || "0.65");
  const wCinema = Number(getSetting("IMAGE_QC_W_CINEMA") || "0.35");
  const qcMaxRegen = Math.max(0, Number(getSetting("IMAGE_QC_MAX_REGEN") || "1"));
  const tempPaths: string[] = [];
  let best = { path: filePath, jobId: jobId0, rank: -1, subject: 0, final: 0 };

  for (let attempt = 0; ; attempt++) {
    let curPath = filePath;
    let curJob = jobId0;
    if (attempt > 0) {
      curPath = filePath.replace(/\.png$/i, `__qc${attempt}.png`);
      tempPaths.push(curPath);
      curJob = await produceAiImage(curPath);
    }
    const s = await verifyFrame(runId, curPath, {
      sceneText: scene.text,
      visualPrompt: scene.visual_prompt,
      subjects: refNames,
    });
    const finalScore = wSubject * s.subjectScore + wCinema * s.cinemaScore;
    // Keep-best ranking:
    //  - log mode (calibration): rank by subjectScore alone — cinema must not yet
    //    influence selection.
    //  - weighted mode: the subject FLOOR still dominates. A candidate below the
    //    floor (wrong species/age) can never beat one above it, no matter how
    //    cinematic — otherwise a gorgeous wrong-subject frame (high cinema, high
    //    finalScore) would win over a correct-but-plain one. So: floor-passers are
    //    ranked above the floor-failer band (+1000) and ordered by finalScore among
    //    themselves; floor-failers (only kept when nothing passes) are ordered by
    //    subjectScore, i.e. keep the candidate CLOSEST to the right subject.
    const rank =
      qcMode === "weighted"
        ? (s.subjectScore >= subjFloor ? 1000 + finalScore : s.subjectScore)
        : s.subjectScore;
    if (rank > best.rank) best = { path: curPath, jobId: curJob, rank, subject: s.subjectScore, final: finalScore };

    if (s.available) {
      log(
        runId,
        "info",
        `QC #${scene.index} subject=${s.subjectScore} cinema=${s.cinemaScore} final=${finalScore.toFixed(1)} (${qcMode})${s.reason ? ` — ${s.reason}` : ""}`,
        { stage: "qc" }
      );
    }

    // Accept on fail-open (QC unavailable), or when the gate passes. The gate:
    // subject floor is hard in BOTH modes; finalScore only gates when enforced.
    const pass =
      !s.available ||
      (s.subjectScore >= subjFloor && (qcMode !== "weighted" || finalScore >= finalBar));
    if (pass) break;

    if (attempt >= qcMaxRegen) {
      log(runId, "warn", `QC #${scene.index} below gate after ${qcMaxRegen} regen — keeping best (subject ${best.subject})`, { stage: "qc" });
      break;
    }
    const why = s.subjectScore < subjFloor ? `subject ${s.subjectScore} < floor ${subjFloor}` : `final ${finalScore.toFixed(1)} < ${finalBar}`;
    log(runId, "warn", `QC #${scene.index} ${why} — regenerating (${attempt + 1}/${qcMaxRegen})`, { stage: "qc" });
  }

  // Promote the best attempt to the canonical file, then clean up temp attempts.
  if (best.path !== filePath) {
    try {
      fs.copyFileSync(best.path, filePath);
    } catch (e) {
      log(runId, "warn", `QC #${scene.index} could not promote best frame: ${(e as Error).message.slice(0, 80)}`, { stage: "qc" });
    }
  }
  for (const p of tempPaths) {
    if (p === filePath) continue;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* best-effort cleanup */
    }
  }
  log(runId, "success", `Image saved: ${fileName} (QC subject ${best.subject}, final ${best.final.toFixed(0)})`, { stage: "image" });
  return { filePath, providerJobId: best.jobId, provider };
}

/**
 * Generate ONE image from a raw prompt straight to `outPath` — no Scene, no
 * per-scene routing. Used by the thumbnail feature. Dispatches to the same
 * provider functions as scenes, so it inherits the 69labs/kie retry +
 * content-moderation softening and the IMAGE_RATIO / IMAGE_MODEL settings.
 */
export async function generateImageToPath(
  runId: string,
  prompt: string,
  outPath: string,
  opts?: { aspectRatio?: string }
): Promise<void> {
  const provider = (getSetting("IMAGE_PROVIDER") || "69labs").toLowerCase();
  if (provider === "69labs") {
    await labs69Image(runId, prompt, outPath, undefined, opts);
  } else if (provider === "kie") {
    await kieImage(runId, prompt, outPath, undefined, opts);
  } else if (provider === "replicate") {
    await replicateImage(prompt, outPath);
  } else if (provider === "openai") {
    await openaiImage(prompt, outPath);
  } else if (provider === "fal") {
    await falImage(prompt, outPath);
  } else {
    throw new Error(`Unknown image provider: ${provider}`);
  }
}

/** Does an image-job error look like a content-moderation rejection?
 *  Covers BOTH 69labs wording ("generation pipeline", "restricted", "flagged")
 *  AND kie/Gemini wording ("blocked", "prohibited", "violates usage policy",
 *  "IMAGE_SAFETY", "sensitive") — otherwise the soften-and-retry rescue silently
 *  never fires on kie for Reign's predator prompts. */
function looksModerated(msg: string): boolean {
  return /generation pipeline|restricted|misclassif|flagged|moderat|content policy|safety|nsfw|blocked|prohibit|violat|usage polic|sensitive|not allowed|image_safety|explicit|sexual/i.test(
    msg
  );
}

/** 69labs (and most image models) reject "violent" wording even for tasteful
 *  wildlife/predator content (Reign's animal-battle channel hits this a lot).
 *  When a job is flagged we retry once with a softened prompt: swap the trigger
 *  words for neutral ones and bolt on a strong advertiser-safe clause. Crude,
 *  but it rescues the scene instead of failing the whole run. */
function softenPrompt(prompt: string): string {
  const swaps: [RegExp, string][] = [
    [/\bkill(?:s|ing|ed)?\b/gi, "confronting"],
    [/\battack(?:s|ing|ed)?\b/gi, "approaching"],
    [/\bblood(?:y|ied)?\b/gi, ""],
    [/\bgore\b|\bgory\b/gi, ""],
    [/\bfight(?:s|ing)?\b/gi, "facing off"],
    [/\bprey\b/gi, "rival"],
    [/\bbit(?:e|es|ing)\b/gi, "open jaws"],
    [/\blung(?:e|es|ing)\b/gi, "leaping"],
    [/\b(?:tear|tears|tearing|rip|rips|ripping)\b/gi, ""],
    [/\b(?:savage|brutal|vicious|deadly|ferocious|violent|violence|bloodthirsty)\b/gi, "powerful"],
    [/\b(?:carcass|corpse|dead)\b/gi, ""],
    [/\b(?:wound|wounded|wounds|injury|injured|injuries)\b/gi, ""],
    [/\bslash(?:es|ing)?\b/gi, "raised paw"],
  ];
  let out = prompt;
  for (const [re, rep] of swaps) out = out.replace(re, rep);
  out = out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/([,.])\1+/g, "$1")
    .replace(/[\s,.]+$/, "")
    .trim();
  return `${out}. Tasteful wildlife documentary photography, advertiser-friendly: no violence, no gore, no blood — show only the calm, tense moment before any action, natural and non-graphic.`;
}

async function labs69Image(
  runId: string,
  prompt: string,
  outPath: string,
  imageUrls?: string[],
  opts?: { aspectRatio?: string }
): Promise<string> {
  const model = getSetting("IMAGE_MODEL") || undefined; // server default = imagen-4
  // opts.aspectRatio overrides the global IMAGE_RATIO (e.g. character portraits
  // force 3:4) — falls back to the setting for normal scene images.
  let aspectRatio = opts?.aspectRatio || getSetting("IMAGE_RATIO") || undefined;

  // Imagen 4 only accepts 'square|portrait|landscape', not numeric ratios like '16:9'.
  // Safely map for the Imagen family.
  const isImagen = !model || /^imagen/i.test(model);
  if (isImagen && aspectRatio) {
    const map: Record<string, string> = {
      "16:9": "landscape", "21:9": "landscape", "4:3": "landscape", "3:2": "landscape",
      "1:1": "square",
      "9:16": "portrait", "9:21": "portrait", "3:4": "portrait", "2:3": "portrait",
    };
    aspectRatio = map[aspectRatio] ?? aspectRatio;
  }

  // Imagen ignores reference images — so character consistency AND scene
  // continuity silently do nothing on it. Warn once so a user who switched
  // IMAGE_MODEL to imagen (or cleared it) knows why the look isn't sticking.
  if (isImagen && imageUrls?.length) {
    log(
      runId,
      "warn",
      `IMAGE_MODEL "${model ?? "imagen (server default)"}" ignores reference images — character consistency & scene continuity won't apply. Use nano-banana-pro for those.`,
      { stage: "image" }
    );
  }

  const resolution = getSetting("IMAGE_RESOLUTION") || undefined;

  // Retry: on timeout we cancel the stuck job first to free the concurrent slot.
  // nano-banana-pro on 69labs returns transient FAILED ("job failed to complete")
  // under load, so a 4th attempt meaningfully lifts the per-scene success rate
  // (and keeps the run under the >25% scene-drop abort threshold).
  const MAX_ATTEMPTS = 4;
  let lastErr: unknown;
  let lastJobId: string | null = null;
  // These can change between attempts: a content-moderation failure swaps in a
  // softened, reference-free prompt for the next try.
  let currentPrompt = prompt;
  let currentImageUrls = imageUrls;
  let softened = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const jobId = await createImageJob({
        prompt: currentPrompt,
        model,
        aspectRatio,
        resolution,
        imageUrls: currentImageUrls?.length ? currentImageUrls : undefined,
        runId,
      });
      lastJobId = jobId;
      log(
        runId,
        "debug",
        `69labs image job ${jobId.slice(0, 8)}… (model=${model ?? "default"}, aspect=${aspectRatio}, res=${resolution ?? "default"}, attempt=${attempt})`,
        { stage: "image" }
      );
      await pollJob("images", jobId, runId, "image");
      await downloadJob("images", jobId, outPath);
      return jobId;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);

      // On a stall/timeout the job is still alive on 69labs — cancel it to free
      // its concurrency slot (cancelJob releases the key slot internally). For
      // other error types (FAILED/CENSORED, download failed) the job is already
      // dead, so we just release the key. NOTE: must match pollJob's ACTUAL
      // messages ("stalled", "hard cap", "timed out") — the old /polling timeout/
      // never matched, leaking a remote slot on every stalled job.
      if (lastJobId) {
        if (/stalled|hard cap|timed out|timeout/i.test(msg)) {
          const cancelled = await cancelJob("images", lastJobId);
          log(runId, "debug", `Cancelled ${lastJobId.slice(0, 8)} → ${cancelled ? "ok" : "skipped"}`, {
            stage: "image",
          });
        } else {
          // Free the key slot even on non-timeout errors so retries don't pile up
          releaseJob(lastJobId);
        }
      }

      // 69labs content moderation: the prompt (or a reference image) was flagged.
      // Retrying the same text is pointless — soften it + drop refs once, then
      // the remaining attempt(s) use the safe version.
      if (!softened && looksModerated(msg)) {
        currentPrompt = softenPrompt(prompt);
        currentImageUrls = undefined;
        softened = true;
        log(runId, "warn", `Image #${path.basename(outPath)} flagged by the 69labs content filter — retrying with a softened, reference-free prompt`, {
          stage: "image",
        });
      }

      if (attempt < MAX_ATTEMPTS) {
        // Exponential backoff + jitter to let slots thaw and de-sync concurrent
        // retries (several scenes often fail in the same wave, so identical
        // backoffs would resubmit them all at once and re-spike the provider).
        const delay = 5000 * attempt + Math.floor(Math.random() * 2000);
        log(runId, "warn", `image attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg.slice(0, 200)} — retry in ${delay}ms`, {
          stage: "image",
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** kie.ai image generation — same retry + moderation-soften behavior as 69labs.
 *  Model / aspect / resolution come from the SAME settings, mapped to kie ids,
 *  so switching providers needs no other changes. Reference images (character
 *  consistency) pass through `image_input` (kie supports up to 8 URLs). */
async function kieImage(
  runId: string,
  prompt: string,
  outPath: string,
  imageUrls?: string[],
  opts?: { aspectRatio?: string }
): Promise<void> {
  const model = kieImageModel(getSetting("IMAGE_MODEL") || "");
  const aspectRatio = opts?.aspectRatio || getSetting("IMAGE_RATIO") || "16:9";
  const resolution = kieResolution(getSetting("IMAGE_RESOLUTION") || "");

  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  let currentPrompt = prompt;
  let currentImageUrls = imageUrls;
  let softened = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const input: Record<string, unknown> = {
        prompt: currentPrompt,
        output_format: "png",
        aspect_ratio: aspectRatio,
      };
      if (resolution) input.resolution = resolution;
      if (currentImageUrls?.length) input.image_input = currentImageUrls.slice(0, 8);

      const taskId = await createKieTask(model, input, { runId, stage: "image" });
      log(runId, "debug", `kie image task ${taskId.slice(0, 12)}… (model=${model}, aspect=${aspectRatio}, attempt=${attempt})`, {
        stage: "image",
      });
      const urls = await pollKieTask(taskId, runId, "image");
      await downloadKieFile(urls[0], outPath);
      return;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);

      if (!softened && looksModerated(msg)) {
        currentPrompt = softenPrompt(prompt);
        currentImageUrls = undefined;
        softened = true;
        log(runId, "warn", `Image ${path.basename(outPath)} flagged by the kie.ai content filter — retrying with a softened, reference-free prompt`, {
          stage: "image",
        });
      }

      if (attempt < MAX_ATTEMPTS) {
        const delay = 5000 * attempt;
        log(runId, "warn", `image attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg.slice(0, 200)} — retry in ${delay}ms`, {
          stage: "image",
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Replicate / OpenAI / fal call bare global fetch, which has NO default timeout
// in Node — a hung remote connection blocks the call indefinitely (this is what
// stalled an upfront character portrait for ~10 min). Wrap every such request in
// an AbortController bound to IMG_FETCH_TIMEOUT_MS so a stalled provider fails
// fast with a clear message instead of hanging. (69labs/kie already use their
// own fetchWithTimeout; this covers the remaining direct-fetch providers.)
const IMG_FETCH_TIMEOUT_MS = 120_000;
async function fetchT(
  input: string,
  init?: RequestInit,
  timeoutMs: number = IMG_FETCH_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...(init ?? {}), signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(`image request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(`image request network error: ${cause?.code || cause?.message || (e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}

async function replicateImage(prompt: string, outPath: string) {
  const token = getSetting("REPLICATE_API_TOKEN");
  if (!token) throw new Error("REPLICATE_API_TOKEN is not set");
  const model = getSetting("IMAGE_MODEL") || "black-forest-labs/flux-schnell";
  const aspect = getSetting("IMAGE_RATIO") || "16:9";

  const create = await fetchT(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({ input: { prompt, aspect_ratio: aspect, output_format: "png" } }),
  });

  if (!create.ok) {
    throw new Error(`Replicate ${create.status}: ${(await create.text()).slice(0, 300)}`);
  }
  const json = (await create.json()) as { output?: string | string[] };
  const urlOrUrls = json.output;
  let imageUrl: string | undefined;
  if (typeof urlOrUrls === "string") imageUrl = urlOrUrls;
  else if (Array.isArray(urlOrUrls) && urlOrUrls.length > 0) imageUrl = urlOrUrls[0];
  if (!imageUrl) throw new Error(`Replicate returned no output: ${JSON.stringify(json).slice(0, 300)}`);

  const img = await fetchT(imageUrl);
  if (!img.ok) throw new Error(`Failed to download image: ${img.status}`);
  fs.writeFileSync(outPath, Buffer.from(await img.arrayBuffer()));
}

async function openaiImage(prompt: string, outPath: string) {
  const key = getSetting("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const model = getSetting("IMAGE_MODEL") || "gpt-image-1";

  const resp = await fetchT("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size: "1792x1024", n: 1 }),
  });
  if (!resp.ok) throw new Error(`OpenAI image ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const json = (await resp.json()) as { data: { b64_json?: string; url?: string }[] };
  const item = json.data?.[0];
  if (item?.b64_json) {
    fs.writeFileSync(outPath, Buffer.from(item.b64_json, "base64"));
  } else if (item?.url) {
    const r = await fetchT(item.url);
    fs.writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
  } else {
    throw new Error("OpenAI image: empty output");
  }
}

async function falImage(prompt: string, outPath: string) {
  const key = getSetting("FAL_API_KEY");
  if (!key) throw new Error("FAL_API_KEY is not set");
  const model = getSetting("IMAGE_MODEL") || "fal-ai/flux/schnell";
  const aspect = getSetting("IMAGE_RATIO") || "16:9";

  const resp = await fetchT(`https://fal.run/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, aspect_ratio: aspect, output_format: "png" }),
  });
  if (!resp.ok) throw new Error(`fal ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const json = (await resp.json()) as { images?: { url: string }[] };
  const url = json.images?.[0]?.url;
  if (!url) throw new Error("fal: empty output");
  const img = await fetchT(url);
  fs.writeFileSync(outPath, Buffer.from(await img.arrayBuffer()));
}

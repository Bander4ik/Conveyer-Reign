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
  /** Continuity: a public image URL of the shot's anchor frame. When set, this
   *  scene is generated to match it (same subjects/look, different angle). */
  chainRefUrl?: string
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
  const finalPrompt =
    (refUrls.length > 0
      ? `${scene.visual_prompt}. The character(s) ${refNames
          .map((n) => `"${n}"`)
          .join(", ")} must match the person(s) in the provided reference image(s) — keep their face, hair, and clothing consistent. ${styleSuffix}`
      : `${scene.visual_prompt}, ${styleSuffix}`) + continuityClause;
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

  if (provider === "69labs") {
    const jobId = await labs69Image(runId, finalPrompt, filePath, allRefs);
    log(runId, "success", `Image saved: ${fileName}`, { stage: "image" });
    return { filePath, providerJobId: jobId, provider };
  }
  if (provider === "kie") {
    await kieImage(runId, finalPrompt, filePath, allRefs);
    log(runId, "success", `Image saved: ${fileName}`, { stage: "image" });
    return { filePath, provider };
  }
  if (refUrls.length > 0) {
    log(runId, "warn", `Character references are only wired for the 69labs image provider — ignored for "${provider}"`, {
      stage: "image",
    });
  }
  if (provider === "replicate") {
    await replicateImage(finalPrompt, filePath);
  } else if (provider === "openai") {
    await openaiImage(finalPrompt, filePath);
  } else if (provider === "fal") {
    await falImage(finalPrompt, filePath);
  } else {
    throw new Error(`Unknown image provider: ${provider}`);
  }
  log(runId, "success", `Image saved: ${fileName}`, { stage: "image" });
  return { filePath, provider };
}

/**
 * Generate ONE image from a raw prompt straight to `outPath` — no Scene, no
 * per-scene routing. Used by the thumbnail feature. Dispatches to the same
 * provider functions as scenes, so it inherits the 69labs/kie retry +
 * content-moderation softening and the IMAGE_RATIO / IMAGE_MODEL settings.
 */
export async function generateImageToPath(runId: string, prompt: string, outPath: string): Promise<void> {
  const provider = (getSetting("IMAGE_PROVIDER") || "69labs").toLowerCase();
  if (provider === "69labs") {
    await labs69Image(runId, prompt, outPath);
  } else if (provider === "kie") {
    await kieImage(runId, prompt, outPath);
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

/** Does a 69labs job error look like a content-moderation rejection? */
function looksModerated(msg: string): boolean {
  return /generation pipeline|restricted|misclassif|flagged|moderat|content policy|safety|nsfw/i.test(msg);
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

async function labs69Image(runId: string, prompt: string, outPath: string, imageUrls?: string[]): Promise<string> {
  const model = getSetting("IMAGE_MODEL") || undefined; // server default = imagen-4
  let aspectRatio = getSetting("IMAGE_RATIO") || undefined;

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

  const resolution = getSetting("IMAGE_RESOLUTION") || undefined;

  // Retry: on timeout we cancel the stuck job first to free the concurrent slot.
  const MAX_ATTEMPTS = 3;
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

      // On polling timeout — cancel the orphaned job to free its concurrency slot.
      // cancelJob() releases the key slot internally. For other error types
      // (poll itself failed, download failed) we still need to release the key
      // since the job is dead to us.
      if (lastJobId) {
        if (/polling timeout/i.test(msg)) {
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
        // Exponential backoff to let slots thaw
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

/** kie.ai image generation — same retry + moderation-soften behavior as 69labs.
 *  Model / aspect / resolution come from the SAME settings, mapped to kie ids,
 *  so switching providers needs no other changes. Reference images (character
 *  consistency) pass through `image_input` (kie supports up to 8 URLs). */
async function kieImage(runId: string, prompt: string, outPath: string, imageUrls?: string[]): Promise<void> {
  const model = kieImageModel(getSetting("IMAGE_MODEL") || "");
  const aspectRatio = getSetting("IMAGE_RATIO") || "16:9";
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

async function replicateImage(prompt: string, outPath: string) {
  const token = getSetting("REPLICATE_API_TOKEN");
  if (!token) throw new Error("REPLICATE_API_TOKEN is not set");
  const model = getSetting("IMAGE_MODEL") || "black-forest-labs/flux-schnell";
  const aspect = getSetting("IMAGE_RATIO") || "16:9";

  const create = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
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

  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error(`Failed to download image: ${img.status}`);
  fs.writeFileSync(outPath, Buffer.from(await img.arrayBuffer()));
}

async function openaiImage(prompt: string, outPath: string) {
  const key = getSetting("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const model = getSetting("IMAGE_MODEL") || "gpt-image-1";

  const resp = await fetch("https://api.openai.com/v1/images/generations", {
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
    const r = await fetch(item.url);
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

  const resp = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, aspect_ratio: aspect, output_format: "png" }),
  });
  if (!resp.ok) throw new Error(`fal ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const json = (await resp.json()) as { images?: { url: string }[] };
  const url = json.images?.[0]?.url;
  if (!url) throw new Error("fal: empty output");
  const img = await fetch(url);
  fs.writeFileSync(outPath, Buffer.from(await img.arrayBuffer()));
}

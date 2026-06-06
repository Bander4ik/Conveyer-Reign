import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { getPrompt } from "../prompts";
import { log } from "../logger";
import type { Scene } from "./scene-split";
import { createImageJob, pollJob, downloadJob, cancelJob, releaseJob } from "./labs69";
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
  realImageMode?: boolean
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

  const finalPrompt =
    refUrls.length > 0
      ? `${scene.visual_prompt}. The character(s) ${refNames
          .map((n) => `"${n}"`)
          .join(", ")} must match the person(s) in the provided reference image(s) — keep their face, hair, and clothing consistent. ${styleSuffix}`
      : `${scene.visual_prompt}, ${styleSuffix}`;
  const fileName = `scene_${String(scene.index).padStart(3, "0")}.png`;
  const filePath = path.join(outDir, fileName);

  // Science data mode: use a real Wikipedia image for tagged real subjects.
  if (realImageMode && scene.real_subject) {
    const ok = await tryRealImage(runId, scene.real_subject, filePath, scene.real_subject);
    if (ok) {
      log(runId, "success", `Image saved (real photo): ${fileName}`, { stage: "image" });
      return { filePath, provider: "wikimedia" };
    }
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
    const jobId = await labs69Image(runId, finalPrompt, filePath, refUrls);
    log(runId, "success", `Image saved: ${fileName}`, { stage: "image" });
    return { filePath, providerJobId: jobId, provider };
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

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const jobId = await createImageJob({
        prompt,
        model,
        aspectRatio,
        resolution,
        imageUrls: imageUrls?.length ? imageUrls : undefined,
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

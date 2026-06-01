import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { getPrompt } from "../prompts";
import { log } from "../logger";
import { createImageJob, pollJob, downloadJob, releaseJob } from "./labs69";
import { uploadPublicImage } from "./image-host";

/** Max reference images passed to the image model for a single scene. */
export const MAX_CHARACTER_REFS = 3;

/**
 * A character the user defined for a run. Stored (without raw image bytes) in
 * the run's `config_json`. Uploaded photos are written to the run's
 * `characters/` folder and referenced here by path.
 */
export interface CharacterSpec {
  id: string;
  name: string;
  isHost?: boolean;
  /** describe = generate a portrait from `description`; upload = use the saved
   *  file at `inputImagePath`; url = use `imageUrl` directly. */
  source: "describe" | "upload" | "url";
  description?: string;
  inputImagePath?: string;
  imageUrl?: string;
}

/** Defensively parse the cast out of a run's stored config_json. */
export function parseCast(configJson: string | null | undefined): CharacterSpec[] {
  if (!configJson) return [];
  try {
    const cfg = JSON.parse(configJson) as { characters?: unknown };
    if (!Array.isArray(cfg.characters)) return [];
    return cfg.characters
      .map((c, i): CharacterSpec | null => {
        if (!c || typeof c !== "object") return null;
        const o = c as Record<string, unknown>;
        const name = String(o.name ?? "").trim();
        if (!name) return null;
        const source =
          o.source === "upload" || o.source === "url" ? o.source : "describe";
        return {
          id: String(o.id ?? `c${i}`),
          name,
          isHost: Boolean(o.isHost),
          source,
          description: o.description ? String(o.description) : undefined,
          inputImagePath: o.inputImagePath ? String(o.inputImagePath) : undefined,
          imageUrl: o.imageUrl ? String(o.imageUrl) : undefined,
        };
      })
      .filter((c): c is CharacterSpec => c !== null);
  } catch {
    return [];
  }
}

/**
 * For each character, produce a public reference-image URL the image model can
 * fetch, and return a `name → url` map. Per-character failures are logged and
 * skipped (that character just won't be locked) — they never abort the run.
 */
export async function prepareCharacterReferences(
  runId: string,
  cast: CharacterSpec[],
  charDir: string
): Promise<Record<string, string>> {
  if (cast.length === 0) return {};
  fs.mkdirSync(charDir, { recursive: true });

  const refs: Record<string, string> = {};
  for (const ch of cast) {
    try {
      // 1. Use a directly-provided public URL as-is.
      if (ch.source === "url" && ch.imageUrl?.trim()) {
        refs[ch.name] = ch.imageUrl.trim();
        log(runId, "success", `Character "${ch.name}" → using provided image URL`, {
          stage: "character",
        });
        continue;
      }

      // 2. Otherwise resolve to a local image: an uploaded file, or a freshly
      //    generated portrait from the description.
      let localPath: string | undefined;
      if (ch.source === "upload" && ch.inputImagePath && fs.existsSync(ch.inputImagePath)) {
        localPath = ch.inputImagePath;
      } else {
        const desc = ch.description?.trim() || ch.name;
        localPath = await generatePortrait(runId, ch, desc, charDir);
      }
      if (!localPath) throw new Error("no reference image produced");

      // 3. Host it so 69labs can fetch it.
      const url = await uploadPublicImage(localPath);
      refs[ch.name] = url;
      log(runId, "success", `Character "${ch.name}" reference ready`, {
        stage: "character",
        data: { url },
      });
    } catch (e) {
      log(
        runId,
        "warn",
        `Character "${ch.name}" reference failed: ${(e as Error).message.slice(0, 160)} — its scenes won't be locked to a consistent look`,
        { stage: "character" }
      );
    }
  }
  return refs;
}

/** Generate a single clean reference portrait via the configured image model. */
async function generatePortrait(
  runId: string,
  ch: CharacterSpec,
  desc: string,
  charDir: string
): Promise<string> {
  const model = getSetting("IMAGE_MODEL") || undefined;
  const resolution = getSetting("IMAGE_RESOLUTION") || undefined;
  const styleSuffix = getPrompt("image_prompt");
  const prompt =
    `Character reference portrait of ${ch.name}: ${desc}. ` +
    `Single subject, centered, full figure and face clearly visible, neutral plain background, ` +
    `even consistent lighting, sharp detail. ${styleSuffix}`;
  const outPath = path.join(charDir, `${safeId(ch.id)}_ref.png`);

  log(runId, "info", `Generating reference portrait for "${ch.name}"`, { stage: "character" });
  const jobId = await createImageJob({ prompt, model, aspectRatio: "3:4", resolution, runId });
  try {
    await pollJob("images", jobId, runId, "character");
    await downloadJob("images", jobId, outPath); // releases the key slot
  } catch (e) {
    releaseJob(jobId);
    throw e;
  }
  return outPath;
}

function safeId(s: string): string {
  return s.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40) || "char";
}

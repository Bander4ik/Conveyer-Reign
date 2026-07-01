import fs from "node:fs";
import path from "node:path";
import { getPrompt } from "../prompts";
import { log } from "../logger";
import { pLimit } from "../plimit";
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
  charDir: string,
  imageStyle?: string
): Promise<Record<string, string>> {
  if (cast.length === 0) return {};
  fs.mkdirSync(charDir, { recursive: true });

  const refs: Record<string, string> = {};
  // Resolve the cast CONCURRENTLY. Portrait generation is the slowest upfront
  // step (each nano-banana-pro portrait is provider-slow) and it blocks all
  // scene work, so running the cast in parallel collapses N sequential portrait
  // waits into roughly one. Bound the fan-out so a large manual cast can't exceed
  // 69labs' ~7-image/key ceiling; for the typical auto-cast (≤4) this is
  // effectively full parallel. Per-character failures stay isolated (caught
  // below) so one bad portrait never aborts the others or the run.
  const limit = pLimit(Math.min(Math.max(cast.length, 1), 4));
  await Promise.all(
    cast.map((ch) =>
      limit(async () => {
        try {
          // 1. Use a directly-provided public URL as-is.
          if (ch.source === "url" && ch.imageUrl?.trim()) {
            refs[ch.name] = ch.imageUrl.trim();
            log(runId, "success", `Character "${ch.name}" → using provided image URL`, {
              stage: "character",
            });
            return;
          }

          // 2. Otherwise resolve to a local image: an uploaded file, or a freshly
          //    generated portrait from the description.
          let localPath: string | undefined;
          if (ch.source === "upload" && ch.inputImagePath && fs.existsSync(ch.inputImagePath)) {
            localPath = ch.inputImagePath;
          } else {
            const desc = ch.description?.trim() || ch.name;
            localPath = await generatePortrait(runId, ch, desc, charDir, imageStyle);
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
      })
    )
  );
  return refs;
}

/** Generate a single clean reference portrait via the configured image model. */
async function generatePortrait(
  runId: string,
  ch: CharacterSpec,
  desc: string,
  charDir: string,
  imageStyle?: string
): Promise<string> {
  const styleSuffix = imageStyle ?? getPrompt("image_prompt");
  const prompt =
    `Character reference portrait of ${ch.name}: ${desc}. ` +
    `Single subject, centered, full figure and face clearly visible, neutral plain background, ` +
    `even consistent lighting, sharp detail. ${styleSuffix}`;
  const outPath = path.join(charDir, `${safeId(ch.id)}_ref.png`);

  log(runId, "info", `Generating reference portrait for "${ch.name}"`, { stage: "character" });
  // Route through the SHARED, hardened image path so portraits inherit the same
  // 3-attempt retry + cancel-on-stall + content-moderation rescue as scene
  // images. Previously this called pollJob directly with no retry, so a single
  // stalled portrait blocked the whole (sequential, upfront) character step for
  // ~8 minutes. The 3:4 override keeps the portrait framing for the providers
  // that honor it (69labs/kie); replicate/openai/fal use IMAGE_RATIO as before.
  // Lazy import avoids a static import cycle with image-gen.
  const { generateImageToPath } = await import("./image-gen");
  await generateImageToPath(runId, prompt, outPath, { aspectRatio: "3:4" });
  return outPath;
}

function safeId(s: string): string {
  return s.replace(/[^a-z0-9_-]/gi, "_").slice(0, 40) || "char";
}

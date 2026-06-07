import fs from "node:fs";
import ffmpeg from "fluent-ffmpeg";
import { getSetting } from "../settings";
import { log } from "../logger";
import { drawtextFont, escDrawtext } from "./fonts";

/**
 * Per-scene real images — fetches a REAL photo from Wikipedia for a scene the
 * scene-split prompt tagged "real_image" (via real_image_query) or
 * "person_overlay" (via wikipedia_lookup), normalizes it to the video size and
 * burns an optional name label. Used instead of the AI image for that scene.
 *
 * Images come from Wikipedia's lead-image (PageImages) — mostly Wikimedia
 * Commons. Best-effort: any failure returns false and the caller falls back to
 * the AI image.
 */

const UA = "ConveyerReign/1.0 (faceless video pipeline; contact: local user)";

function applyFfmpegPath(): void {
  const p = getSetting("FFMPEG_PATH");
  if (p) ffmpeg.setFfmpegPath(p);
}

interface WikiHit {
  title: string;
  url: string;
}

async function searchWikiImage(query: string): Promise<WikiHit | null> {
  // generator=search finds the best-matching article; prop=pageimages returns
  // its lead image thumbnail at the requested size.
  const api =
    "https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1" +
    "&prop=pageimages&piprop=thumbnail&pithumbsize=2000" +
    `&generator=search&gsrlimit=1&gsrsearch=${encodeURIComponent(query)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(api, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok) return null;
    const json = (await r.json()) as {
      query?: { pages?: Record<string, { title?: string; thumbnail?: { source?: string } }> };
    };
    const pages = json.query?.pages ? Object.values(json.query.pages) : [];
    for (const p of pages) {
      if (p.thumbnail?.source) return { title: p.title || query, url: p.thumbnail.source };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch + normalize + label a real image for `query`, writing it to `outPath`
 * (a scene PNG). Returns true on success, false to fall back to the AI image.
 */
export async function tryRealImage(
  runId: string,
  query: string,
  outPath: string,
  label: string
): Promise<boolean> {
  const hit = await searchWikiImage(query);
  if (!hit) {
    log(runId, "info", `Real image: no Wikipedia image for "${query}" — falling back to AI`, {
      stage: "image",
    });
    return false;
  }

  const tmp = `${outPath}.src`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(hit.url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!r.ok) return false;
    fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }

  const [w, h] = (getSetting("VIDEO_RESOLUTION") || "1920x1080").split("x").map(Number);
  try {
    await normalizeAndLabel(tmp, outPath, w, h, label);
    log(runId, "success", `Real image: "${query}" → ${hit.title}`, {
      stage: "image",
      data: { url: hit.url },
    });
    return true;
  } catch (e) {
    log(runId, "warn", `Real image: processing failed for "${query}": ${(e as Error).message.slice(0, 140)}`, {
      stage: "image",
    });
    return false;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

/** Fit the image into w×h (letterboxed) and burn a lower-third name label. */
function normalizeAndLabel(src: string, outPath: string, w: number, h: number, label: string): Promise<void> {
  applyFfmpegPath();
  const font = drawtextFont();
  const safe = escDrawtext(label);
  const filters = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x000000`,
    `setsar=1`,
  ];
  if (safe && font) {
    filters.push(`drawbox=x=0:y=${Math.round(h * 0.82)}:w=${w}:h=${Math.round(h * 0.12)}:color=0x000000@0.55:t=fill`);
    filters.push(
      `drawtext=fontfile=${font}:text='${safe}':x=(w-text_w)/2:y=${Math.round(h * 0.845)}:fontsize=${Math.round(h / 22)}:fontcolor=0xffffff`
    );
  }
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(src)
      .videoFilters(filters)
      .outputOptions(["-frames:v 1"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

import fs from "node:fs";
import { getSetting } from "../settings";
import { log } from "../logger";
import { checkCancelled } from "../cancellation";
import type { Scene } from "./scene-split";

/**
 * Pexels stock footage service — search + download.
 *
 * Real found-footage source (video + photo) used ALONGSIDE AI generation in
 * Conveyer Reign, selectable per channel as a visual source.
 *
 * Free tier: 200 req/hour, 20 000/month. The API key is required.
 * Sign-up: https://www.pexels.com/api/  (free, ~30 seconds)
 * Docs:    https://www.pexels.com/api/documentation/
 *
 * Attribution: Pexels licenses everything for commercial use without
 * attribution, but their TOS recommend a credit "Video by <author> from
 * Pexels". We log the author name on every download so it can land in the
 * final video's description block later.
 */

const PEXELS_BASE = "https://api.pexels.com";

// ── Types (mirroring Pexels API JSON) ────────────────────────────────────────

export interface PexelsVideoFile {
  id: number;
  quality: string;       // "hd" | "sd" | "uhd"
  file_type: string;     // "video/mp4"
  width: number;
  height: number;
  link: string;          // direct download URL
}

export interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number;      // seconds
  url: string;           // pexels.com page URL (not a file)
  image: string;         // thumbnail URL
  video_files: PexelsVideoFile[];
  user?: { name?: string; url?: string };
}

interface PexelsVideoSearchResponse {
  total_results: number;
  page: number;
  per_page: number;
  videos: PexelsVideo[];
  next_page?: string;
}

export type Orientation = "landscape" | "portrait" | "square";

export interface StockSearchOptions {
  orientation?: Orientation;
  /** Pexels accepts "large" (4K+) / "medium" (1080p+) / "small" (HD). */
  size?: "large" | "medium" | "small";
  /** Filters out flashy short stingers (< minDuration seconds). */
  minDuration?: number;
  /** Max results per request (default 15, max 80). */
  perPage?: number;
}

// ── Photo types (Pexels Photos API) ──────────────────────────────────────────

export interface PexelsPhotoSrc {
  original: string;   // full-resolution original
  large2x: string;    // ~1880px wide — good default for 1080p
  large: string;      // ~940px wide
  medium: string;     // ~640px wide
  small: string;
  portrait: string;
  landscape: string;
  tiny: string;
}

export interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;           // pexels.com page URL
  photographer: string;
  photographer_url?: string;
  src: PexelsPhotoSrc;
  alt?: string;
}

interface PexelsPhotoSearchResponse {
  total_results: number;
  page: number;
  per_page: number;
  photos: PexelsPhoto[];
  next_page?: string;
}

// ── Multi-key pool with rate-limit awareness ────────────────────────────────
//
// Pexels free tier = 200 req/hour, 20 000/month (rolling).
// Successful responses include X-Ratelimit-Remaining + X-Ratelimit-Reset
// (UNIX seconds). On 429 those headers are NOT returned, so we fall back to
// the last resetAt we saw from a successful response.
//
// PEXELS_API_KEY can hold multiple keys (one per line, or comma/semicolon
// separated). The pool tries the current key until it's rate-limited, then
// rotates to the next. When all keys are exhausted at once, it waits on the
// one whose window refreshes earliest, then resumes there.

interface KeyState {
  key: string;
  remaining: number | null;
  resetAt: number | null;          // UNIX seconds (from X-Ratelimit-Reset)
  exhaustedUntilMs: number | null; // UNIX ms — when this key becomes usable again
}

const keyPool: { keys: KeyState[]; cursor: number } = {
  keys: [],
  cursor: 0,
};

/** Re-parse PEXELS_API_KEY each call; preserve state for keys we've seen before. */
function refreshKeyPool(): KeyState[] {
  const raw = getSetting("PEXELS_API_KEY") || "";
  const parsed = raw
    .split(/[\n,;]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  if (parsed.length === 0) {
    throw new Error("PEXELS_API_KEY is not set — add it in /settings (one key per line for multiple)");
  }
  const existing = new Map(keyPool.keys.map((k) => [k.key, k]));
  keyPool.keys = parsed.map(
    (k) =>
      existing.get(k) ?? {
        key: k,
        remaining: null,
        resetAt: null,
        exhaustedUntilMs: null,
      }
  );
  if (keyPool.cursor >= keyPool.keys.length) keyPool.cursor = 0;
  return keyPool.keys;
}

function updateKeyFromHeaders(state: KeyState, headers: Headers): void {
  const rem = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (rem !== null) {
    const n = parseInt(rem, 10);
    if (Number.isFinite(n)) state.remaining = n;
  }
  if (reset !== null) {
    const n = parseInt(reset, 10);
    if (Number.isFinite(n)) state.resetAt = n;
  }
}

function markKeyExhausted(state: KeyState): void {
  // Use the last known reset, else default to one hour from now (Pexels window).
  if (state.resetAt !== null) {
    state.exhaustedUntilMs = state.resetAt * 1000 + 5000; // +5s safety
  } else {
    state.exhaustedUntilMs = Date.now() + 60 * 60 * 1000;
  }
}

/** Cancel-aware sleep — checks `checkCancelled(runId)` every 5 seconds. */
async function sleepWithCancel(ms: number, runId?: string): Promise<void> {
  const CHECK_INTERVAL_MS = 5000;
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (runId) checkCancelled(runId);
    const remaining = ms - (Date.now() - start);
    await new Promise<void>((r) => setTimeout(r, Math.min(CHECK_INTERVAL_MS, remaining)));
  }
}

function formatLocalTime(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Picks an available key. If none are available, sleeps until the
 * earliest-recovering key is ready, then returns it.
 */
async function acquireKey(runId?: string): Promise<KeyState> {
  while (true) {
    const keys = refreshKeyPool();
    const now = Date.now();

    // Scan starting at cursor for any key not currently exhausted.
    for (let i = 0; i < keys.length; i++) {
      const idx = (keyPool.cursor + i) % keys.length;
      const k = keys[idx];
      if (k.exhaustedUntilMs === null || k.exhaustedUntilMs <= now) {
        // This one is available — clear stale state if cooldown ended.
        if (k.exhaustedUntilMs !== null && k.exhaustedUntilMs <= now) {
          k.exhaustedUntilMs = null;
          k.remaining = null;
          if (runId) {
            log(runId, "info", `Pexels key #${idx + 1} cooldown ended — using it`, { stage: "animate" });
          }
        }
        keyPool.cursor = idx;
        return k;
      }
    }

    // All keys exhausted. Find the one that recovers soonest.
    let earliestIdx = 0;
    let earliestUntil = keys[0].exhaustedUntilMs ?? Infinity;
    for (let i = 1; i < keys.length; i++) {
      const u = keys[i].exhaustedUntilMs ?? Infinity;
      if (u < earliestUntil) {
        earliestIdx = i;
        earliestUntil = u;
      }
    }
    const earliest = keys[earliestIdx];
    const waitMs = Math.max(0, (earliest.exhaustedUntilMs ?? now) - now) + 5000;
    const cappedWait = Math.min(waitMs, 75 * 60 * 1000);

    if (runId) {
      const untilLabel = earliest.resetAt !== null ? ` until ${formatLocalTime(earliest.resetAt)}` : "";
      const minutes = Math.max(1, Math.ceil(cappedWait / 60000));
      log(
        runId,
        "warn",
        `All ${keys.length} Pexels key${keys.length === 1 ? "" : "s"} rate-limited — pausing ~${minutes} min${untilLabel}, then auto-resume on key #${earliestIdx + 1}`,
        { stage: "animate" }
      );
    }

    keyPool.cursor = earliestIdx;
    await sleepWithCancel(cappedWait, runId);
    // Loop back to top — re-pick (the woken-up key is now ready).
  }
}

/**
 * Wraps fetch with multi-key rate-limit handling.
 * On 429 → mark current key exhausted → loop, picking the next available key.
 * If every key gets exhausted N times → bail (likely monthly quota hit).
 */
async function pexelsFetch(url: URL | string, runId: string | undefined): Promise<Response> {
  const keys = refreshKeyPool();
  // Allow up to 3 cycles through all keys before giving up (handles edge cases
  // where a key returns 429 even after its supposed reset).
  const MAX_429_HITS = keys.length * 3;

  let hits429 = 0;
  while (hits429 < MAX_429_HITS) {
    const state = await acquireKey(runId);
    const resp = await fetch(url, { headers: { Authorization: state.key } });

    if (resp.status === 429) {
      hits429++;
      try {
        await resp.text();
      } catch {}
      const idx = keyPool.keys.indexOf(state);
      markKeyExhausted(state);
      if (runId) {
        const untilLabel =
          state.resetAt !== null ? ` (window resets ${formatLocalTime(state.resetAt)})` : "";
        log(
          runId,
          "warn",
          `Pexels key #${idx + 1} rate-limited${untilLabel} — rotating to next available key`,
          { stage: "animate" }
        );
      }
      // Move cursor past this one so the next acquireKey starts elsewhere.
      keyPool.cursor = (idx + 1) % keyPool.keys.length;
      continue;
    }

    if (resp.ok) {
      updateKeyFromHeaders(state, resp.headers);
      // Preemptive: if this key is almost out, mark it exhausted so the
      // next request rotates instead of racing into a 429.
      if (state.remaining !== null && state.remaining < 3) {
        markKeyExhausted(state);
      }
    }
    return resp;
  }

  throw new Error(
    `All Pexels keys rate-limited for too long (${MAX_429_HITS} retries) — likely monthly quota exhausted on every key. ` +
      `Check https://www.pexels.com/api/`
  );
}

/** Raw search call. Returns up to options.perPage videos, newest first by relevance. */
export async function searchPexelsVideos(
  query: string,
  options: StockSearchOptions & { runId?: string } = {}
): Promise<PexelsVideo[]> {
  const url = new URL(`${PEXELS_BASE}/videos/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(options.perPage ?? 15));
  if (options.orientation) url.searchParams.set("orientation", options.orientation);
  if (options.size) url.searchParams.set("size", options.size);
  if (options.minDuration && options.minDuration > 0) {
    url.searchParams.set("min_duration", String(options.minDuration));
  }

  const resp = await pexelsFetch(url, options.runId);
  if (!resp.ok) {
    const txt = (await resp.text()).slice(0, 300);
    throw new Error(`Pexels search HTTP ${resp.status}: ${txt}`);
  }
  const data = (await resp.json()) as PexelsVideoSearchResponse;
  return Array.isArray(data.videos) ? data.videos : [];
}

/**
 * Pre-flight connectivity + key check. Does one tiny Pexels search.
 * - Succeeds (or transparently waits out a rate limit) → Pexels is usable.
 * - Throws a clear error → key missing/invalid or network down.
 *
 * The pipeline calls this BEFORE generating any voiceovers, so a misconfigured
 * Pexels key fails in a few seconds instead of after hundreds of paid TTS jobs.
 */
export async function pexelsPreflight(runId: string): Promise<void> {
  await searchPexelsVideos("nature", { perPage: 1, runId });
}

/**
 * Picks the best MP4 file from one Pexels video:
 *  - MP4 only (Pexels also serves .mov sometimes)
 *  - Prefers the largest file whose height is <= maxHeight (no upscaling needed)
 *  - Falls back to smallest file above maxHeight if nothing fits
 */
export function pickBestVideoFile(
  video: PexelsVideo,
  options: { maxHeight?: number } = {}
): PexelsVideoFile | null {
  const maxH = options.maxHeight ?? 1080;
  const mp4s = video.video_files.filter((f) => /mp4/i.test(f.file_type));
  if (mp4s.length === 0) return null;

  const below = mp4s.filter((f) => f.height <= maxH).sort((a, b) => b.height - a.height);
  if (below.length > 0) return below[0];

  // Nothing at or below maxHeight — fall back to the smallest one above
  // (better than nothing; FFmpeg will downscale during assembly).
  return [...mp4s].sort((a, b) => a.height - b.height)[0] ?? null;
}

/** Stream-download a video file to disk. Throws on non-200. */
export async function downloadPexelsVideo(
  videoFile: PexelsVideoFile,
  outPath: string
): Promise<void> {
  const resp = await fetch(videoFile.link);
  if (!resp.ok) {
    throw new Error(`Pexels download HTTP ${resp.status}: ${videoFile.link}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength === 0) {
    throw new Error(`Pexels returned empty file: ${videoFile.link}`);
  }
  fs.writeFileSync(outPath, buf);
}

// ── Pexels Photos ────────────────────────────────────────────────────────────

/** Search Pexels for stock photos matching a query. */
export async function searchPexelsPhotos(
  query: string,
  options: StockSearchOptions & { runId?: string } = {}
): Promise<PexelsPhoto[]> {
  const url = new URL(`${PEXELS_BASE}/v1/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(options.perPage ?? 15));
  if (options.orientation) url.searchParams.set("orientation", options.orientation);
  if (options.size) url.searchParams.set("size", options.size);

  const resp = await pexelsFetch(url, options.runId);
  if (!resp.ok) {
    const txt = (await resp.text()).slice(0, 300);
    throw new Error(`Pexels photo search HTTP ${resp.status}: ${txt}`);
  }
  const data = (await resp.json()) as PexelsPhotoSearchResponse;
  return Array.isArray(data.photos) ? data.photos : [];
}

/** Picks the best photo src URL for our target max-height. */
export function pickBestPhotoSrc(photo: PexelsPhoto, maxHeight = 1080): string {
  // Pexels src tiers don't expose pixel heights directly — but practically:
  // - large2x ≈ 1880x... → good for 1080p
  // - original is full-res (sometimes 5000+px wide)
  // We grab large2x for 1080p targets, original for 4K targets.
  if (maxHeight >= 2000) return photo.src.original;
  if (maxHeight >= 900) return photo.src.large2x;
  if (maxHeight >= 500) return photo.src.large;
  return photo.src.medium;
}

/** Stream-download a photo file to disk. Throws on non-200. */
export async function downloadPexelsPhoto(url: string, outPath: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Pexels photo download HTTP ${resp.status}: ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength === 0) {
    throw new Error(`Pexels returned empty photo: ${url}`);
  }
  fs.writeFileSync(outPath, buf);
}

// ── Scene-level wrapper used by the pipeline ─────────────────────────────────

/**
 * Builds a Pexels-friendly search query from a scene's visual_prompt.
 *
 * The pipeline produces long, descriptive visual_prompts ("An ancient stone
 * temple emerging from misty jungle vines, golden afternoon light filtering
 * through canopy, cinematic wide shot"). Pexels search works much better
 * with shorter natural-language queries.
 *
 * For the MVP we just take the first ~10 words and strip punctuation. Phase 2
 * will route this through Gemini for better keyword extraction.
 */
export function visualPromptToQuery(visualPrompt: string, maxWords = 18): string {
  return visualPrompt
    .split(/\s+/)
    .slice(0, maxWords)
    .join(" ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // drop punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Ordered, cleaned Pexels query candidates for a scene (best first).
 *
 * Uses the scene's `real_image_query` (set by the scene-split prompt) when
 * present, otherwise falls back to the `visual_prompt`. Each is normalized for
 * Pexels and de-duplicated. The acquire helpers try them in order and use the
 * first that returns a usable asset — so a junk/empty first result no longer
 * fails the whole scene.
 */
function sceneQueryCandidates(scene: Scene): string[] {
  // Prefer the scene's explicit real_image_query (set by the scene-split prompt)
  // for "find real footage", otherwise fall back to the visual_prompt.
  const raw = [scene.real_image_query, scene.visual_prompt].filter(
    (q): q is string => typeof q === "string" && q.trim().length > 0
  );
  const cleaned = raw.map((q) => visualPromptToQuery(q)).filter(Boolean);
  return [...new Set(cleaned)];
}

export interface AcquireOptions {
  runId: string;
  orientation?: Orientation;
  maxHeight?: number;
  minDuration?: number;
  /**
   * MUTABLE set of Pexels video ids already claimed/downloaded in this run.
   * The function reads it to skip duplicates AND adds its own pick into it
   * atomically before downloading. Atomicity works because JS is single-
   * threaded — nothing else can interleave between `has()` and `add()`,
   * so even with 5 parallel scenes no two end up with the same clip.
   *
   * Pass a fresh `new Set<number>()` per pipeline run.
   */
  usedIds?: Set<number>;
}

/**
 * High-level helper: search Pexels for a scene's visual_prompt, download the
 * best non-duplicate candidate to outPath. Returns the picked video id.
 *
 * Deduplication: when `usedIds` is provided, candidates already in the set
 * are skipped and the picked id is added to the set before the download
 * starts (so concurrent scenes can't all grab the same clip). If every
 * candidate is already used, falls back to reusing — better a repeat clip
 * than a failed scene.
 *
 * Throws if no candidates download successfully.
 */
export async function acquireStockClipForScene(
  scene: Scene,
  outPath: string,
  options: AcquireOptions
): Promise<{ pexelsId: number; author: string | null; sourceUrl: string }> {
  const { runId, orientation = "landscape", maxHeight = 1080, minDuration = 4, usedIds } = options;

  const candidates = sceneQueryCandidates(scene);
  if (candidates.length === 0) {
    throw new Error(`Scene #${scene.index}: empty Pexels query (no real_image_query or visual_prompt)`);
  }

  let lastErr: unknown;
  // Try each query candidate in order. The first that returns a downloadable,
  // non-duplicate clip wins — so a weak/empty first query falls back instead of
  // failing the scene.
  for (let qi = 0; qi < candidates.length; qi++) {
    const query = candidates[qi];
    const tag = candidates.length > 1 ? ` (query ${qi + 1}/${candidates.length})` : "";
    log(runId, "debug", `Pexels search${tag}: "${query}"`, { stage: "animate" });

    let videos: PexelsVideo[];
    try {
      videos = await searchPexelsVideos(query, { orientation, minDuration, perPage: 15, runId });
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Pexels search failed for "${query}", trying next: ${msg.slice(0, 150)}`, {
        stage: "animate",
      });
      continue;
    }

    if (videos.length === 0) {
      lastErr = new Error(`Pexels returned 0 videos for: "${query}"`);
      if (qi < candidates.length - 1) {
        log(runId, "debug", `No videos for "${query}" — trying next query`, { stage: "animate" });
      }
      continue;
    }

    // First pass: only un-claimed videos. If all candidates are already used,
    // fall back to the full list (a reused clip is better than a failed scene).
    const fresh = usedIds && usedIds.size > 0 ? videos.filter((v) => !usedIds.has(v.id)) : videos;
    const ordered = fresh.length > 0 ? fresh : videos;
    const reusing = fresh.length === 0 && usedIds && usedIds.size > 0;

    for (const video of ordered) {
      // Atomic claim — between has() and add() no other Promise can run.
      if (usedIds && usedIds.has(video.id) && !reusing) continue;
      const file = pickBestVideoFile(video, { maxHeight });
      if (!file) continue;
      if (usedIds && !usedIds.has(video.id)) usedIds.add(video.id);

      try {
        await downloadPexelsVideo(file, outPath);
        const author = video.user?.name ?? null;
        const reusedTag = reusing ? " (reused — no fresh matches)" : "";
        log(
          runId,
          "info",
          `Pexels clip: id=${video.id} ${file.width}x${file.height} ${video.duration}s by ${author ?? "?"}${reusedTag} [${query}]`,
          { stage: "animate", data: { pexelsId: video.id, author, sourceUrl: video.url } }
        );
        return { pexelsId: video.id, author, sourceUrl: video.url };
      } catch (e) {
        // Release the claim — this id failed, let another scene try it.
        if (usedIds && !reusing) usedIds.delete(video.id);
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        log(runId, "warn", `Pexels download failed (${video.id}), trying next: ${msg.slice(0, 150)}`, {
          stage: "animate",
        });
      }
    }
    // Nothing in this query's results downloaded — fall through to next candidate.
  }

  const tried = candidates.map((q) => `"${q}"`).join(", ");
  if (lastErr instanceof Error && /returned 0 videos/.test(lastErr.message)) {
    throw new Error(`Pexels returned 0 videos for scene #${scene.index} (tried ${tried})`);
  }
  throw new Error(
    `All Pexels candidates failed for scene #${scene.index} (tried ${tried})` +
      (lastErr instanceof Error ? `: ${lastErr.message.slice(0, 150)}` : "")
  );
}

// ── Photo acquisition (mirror of acquireStockClipForScene) ───────────────────

export interface AcquirePhotoOptions {
  runId: string;
  orientation?: Orientation;
  maxHeight?: number;
  /** Mutable set of Pexels PHOTO ids already used in this run (separate from video ids). */
  usedIds?: Set<number>;
}

/**
 * High-level helper: search Pexels for a scene's visual_prompt, download the
 * best non-duplicate photo to outPath as JPG. Mirrors `acquireStockClipForScene`
 * but for photos (Pexels has separate video and photo libraries — same scene
 * can yield both, so we keep separate `usedIds` sets per kind).
 *
 * The photo will be turned into a moving clip by FFmpeg's ken-burns step later.
 */
export async function acquireStockPhotoForScene(
  scene: Scene,
  outPath: string,
  options: AcquirePhotoOptions
): Promise<{ pexelsId: number; photographer: string | null; sourceUrl: string }> {
  const { runId, orientation = "landscape", maxHeight = 1080, usedIds } = options;

  const candidates = sceneQueryCandidates(scene);
  if (candidates.length === 0) {
    throw new Error(`Scene #${scene.index}: empty Pexels query (no real_image_query or visual_prompt)`);
  }

  let lastErr: unknown;
  for (let qi = 0; qi < candidates.length; qi++) {
    const query = candidates[qi];
    const tag = candidates.length > 1 ? ` (query ${qi + 1}/${candidates.length})` : "";
    log(runId, "debug", `Pexels photo search${tag}: "${query}"`, { stage: "animate" });

    let photos: PexelsPhoto[];
    try {
      photos = await searchPexelsPhotos(query, { orientation, perPage: 15, runId });
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Pexels photo search failed for "${query}", trying next: ${msg.slice(0, 150)}`, {
        stage: "animate",
      });
      continue;
    }

    if (photos.length === 0) {
      lastErr = new Error(`Pexels returned 0 photos for: "${query}"`);
      if (qi < candidates.length - 1) {
        log(runId, "debug", `No photos for "${query}" — trying next query`, { stage: "animate" });
      }
      continue;
    }

    const fresh = usedIds && usedIds.size > 0 ? photos.filter((p) => !usedIds.has(p.id)) : photos;
    const ordered = fresh.length > 0 ? fresh : photos;
    const reusing = fresh.length === 0 && usedIds && usedIds.size > 0;

    for (const photo of ordered) {
      if (usedIds && usedIds.has(photo.id) && !reusing) continue;
      if (usedIds && !usedIds.has(photo.id)) usedIds.add(photo.id);

      const url = pickBestPhotoSrc(photo, maxHeight);
      try {
        await downloadPexelsPhoto(url, outPath);
        const reusedTag = reusing ? " (reused — no fresh matches)" : "";
        log(
          runId,
          "info",
          `Pexels photo: id=${photo.id} ${photo.width}x${photo.height} by ${photo.photographer || "?"}${reusedTag} [${query}]`,
          { stage: "animate", data: { pexelsId: photo.id, photographer: photo.photographer, sourceUrl: photo.url } }
        );
        return { pexelsId: photo.id, photographer: photo.photographer || null, sourceUrl: photo.url };
      } catch (e) {
        if (usedIds && !reusing) usedIds.delete(photo.id);
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        log(runId, "warn", `Pexels photo download failed (${photo.id}), trying next: ${msg.slice(0, 150)}`, {
          stage: "animate",
        });
      }
    }
  }

  const tried = candidates.map((q) => `"${q}"`).join(", ");
  if (lastErr instanceof Error && /returned 0 photos/.test(lastErr.message)) {
    throw new Error(`Pexels returned 0 photos for scene #${scene.index} (tried ${tried})`);
  }
  throw new Error(
    `All Pexels photo candidates failed for scene #${scene.index} (tried ${tried})` +
      (lastErr instanceof Error ? `: ${lastErr.message.slice(0, 150)}` : "")
  );
}

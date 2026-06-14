import fs from "node:fs";
import { getSetting } from "../settings";
import { log } from "../logger";
import type { Scene } from "./scene-split";
import {
  searchPexelsVideos,
  searchPexelsPhotos,
  pickBestVideoFile,
  pickBestPhotoSrc,
  visualPromptToQuery,
  type Orientation,
} from "./stock-footage";

/**
 * Real-footage source with Gemini-Vision relevance scoring (ported from
 * Conveyer Patrice). For one scene it searches EVERY enabled footage provider
 * in parallel, gathers candidates, and asks Gemini to LOOK AT each candidate's
 * preview image and score 0-100 how well it fits the scene AND the overall video
 * topic. The single best candidate above REAL_MATCH_THRESHOLD wins; otherwise it
 * broadens the query (3 attempts) and finally returns null so the pipeline can
 * fall back to AI.
 *
 * Providers:
 *   - pexels    (video + photo)  — needs PEXELS_API_KEY (reuses stock-footage's key pool)
 *   - openverse (photo)          — keyless (optional OPENVERSE_TOKEN for higher limits)
 *   - wikimedia (photo)          — keyless
 *   - archive   (video)          — keyless (Internet Archive)
 *   - pixabay   (video + photo)  — needs PIXABAY_API_KEY (off unless in FOOTAGE_SOURCES)
 *
 * This module does the SEARCH + SCORE + PICK + DOWNLOAD only. It returns the
 * downloaded file path + kind; the pipeline handles Ken-Burns (for stills) and
 * the AI fallback when this returns null.
 */

export type WantKind = "video" | "image";

export interface ScoredFootage {
  path: string;
  kind: WantKind;
  provider: string;
  matchScore: number;
  attribution?: { author?: string | null; sourceUrl?: string; license?: string | null };
}

interface ProviderHit {
  kind: WantKind;
  /** Direct download URL (video file or image file). */
  url: string;
  /** Stable dedupe id, e.g. "pexels:123" / "pexels-photo:123". */
  dedupeId: string;
  /** Preview image the vision scorer looks at (video poster, or the image). */
  thumbUrl?: string;
  author?: string | null;
  sourceUrl?: string;
  license?: string | null;
  provider?: string;
}

const UA = "ConveyerReign/1.0 (local video tool)";
const SOURCE_POOL_PER_PROVIDER = 5;
const SOURCE_POOL_MAX = 14;

function orientationSetting(): Orientation {
  const o = (getSetting("STOCK_FOOTAGE_ORIENTATION") || "landscape").toLowerCase();
  return o === "portrait" || o === "square" ? (o as Orientation) : "landscape";
}

async function downloadToFile(url: string, outPath: string): Promise<void> {
  const resp = await fetch(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`download ${resp.status}: ${url.slice(0, 120)}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength === 0) throw new Error(`empty download: ${url.slice(0, 120)}`);
  fs.writeFileSync(outPath, buf);
}

async function safe<T>(p: Promise<T[]>): Promise<T[]> {
  try {
    return await p;
  } catch {
    return [];
  }
}

// ── Providers ────────────────────────────────────────────────────────────────

async function pexelsHits(query: string, runId: string, want: WantKind, minDurSec: number): Promise<ProviderHit[]> {
  const orientation = orientationSetting();
  const maxH = Math.max(360, Number(getSetting("STOCK_FOOTAGE_MAX_HEIGHT") || "1080"));
  if (want === "video") {
    const globalMin = Math.max(0, Number(getSetting("STOCK_FOOTAGE_MIN_DURATION") || "4"));
    const wanted = Math.max(globalMin, Math.ceil(minDurSec));
    let videos = await searchPexelsVideos(query, { orientation, minDuration: wanted, perPage: 15, runId });
    if (videos.length === 0 && wanted > globalMin) {
      videos = await searchPexelsVideos(query, { orientation, minDuration: globalMin, perPage: 15, runId });
    }
    const hits: ProviderHit[] = [];
    for (const v of videos) {
      const file = pickBestVideoFile(v, { maxHeight: maxH });
      if (!file) continue;
      hits.push({
        kind: "video",
        url: file.link,
        dedupeId: `pexels:${v.id}`,
        thumbUrl: v.image,
        author: v.user?.name ?? null,
        sourceUrl: v.url,
        license: "Pexels License",
      });
    }
    return hits;
  }
  // photo
  const photos = await searchPexelsPhotos(query, { orientation, perPage: 15, runId });
  return photos.map((p) => ({
    kind: "image" as const,
    url: pickBestPhotoSrc(p, maxH),
    dedupeId: `pexels-photo:${p.id}`,
    thumbUrl: p.src.medium || p.src.small,
    author: p.photographer ?? null,
    sourceUrl: p.url,
    license: "Pexels License",
  }));
}

async function pixabayHits(query: string, want: WantKind, minDurSec: number): Promise<ProviderHit[]> {
  const key = getSetting("PIXABAY_API_KEY");
  if (!key) return [];
  const orient = orientationSetting();
  if (want === "video") {
    const url = new URL("https://pixabay.com/api/videos/");
    url.searchParams.set("key", key);
    url.searchParams.set("q", query.slice(0, 100));
    url.searchParams.set("video_type", "film");
    url.searchParams.set("safesearch", "true");
    url.searchParams.set("per_page", "20");
    if (orient !== "square") url.searchParams.set("orientation", orient === "portrait" ? "vertical" : "horizontal");
    const resp = await fetch(url, { headers: { "User-Agent": UA } });
    if (!resp.ok) throw new Error(`Pixabay videos ${resp.status}`);
    const data = (await resp.json()) as {
      hits?: { id: number; duration?: number; pageURL?: string; user?: string; videos?: Record<string, { url: string }> }[];
    };
    const all = (data.hits ?? [])
      .map((h): (ProviderHit & { durationSec?: number }) | null => {
        const v = h.videos?.large?.url ? h.videos.large : h.videos?.medium;
        if (!v?.url) return null;
        return { kind: "video", url: v.url, dedupeId: `pixabay:${h.id}`, author: h.user ?? null, sourceUrl: h.pageURL, license: "Pixabay License", durationSec: h.duration };
      })
      .filter((x): x is ProviderHit & { durationSec?: number } => x !== null);
    const want2 = Math.ceil(minDurSec);
    const covering = want2 > 0 ? all.filter((h) => (h.durationSec ?? 0) >= want2) : all;
    return covering.length > 0 ? covering : all;
  }
  const url = new URL("https://pixabay.com/api/");
  url.searchParams.set("key", key);
  url.searchParams.set("q", query.slice(0, 100));
  url.searchParams.set("image_type", "photo");
  url.searchParams.set("safesearch", "true");
  url.searchParams.set("per_page", "30");
  url.searchParams.set("min_width", "1280");
  url.searchParams.set("orientation", orient === "portrait" ? "vertical" : "horizontal");
  const resp = await fetch(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`Pixabay images ${resp.status}`);
  const data = (await resp.json()) as {
    hits?: { id: number; pageURL?: string; user?: string; largeImageURL?: string; fullHDURL?: string; webformatURL?: string; previewURL?: string }[];
  };
  return (data.hits ?? [])
    .map((h): ProviderHit | null => {
      const u = h.fullHDURL || h.largeImageURL;
      if (!u) return null;
      return { kind: "image", url: u, dedupeId: `pixabay-img:${h.id}`, thumbUrl: h.webformatURL || h.previewURL || u, author: h.user ?? null, sourceUrl: h.pageURL, license: "Pixabay License" };
    })
    .filter((x): x is ProviderHit => x !== null);
}

async function openverseHits(query: string): Promise<ProviderHit[]> {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query);
  url.searchParams.set("license", "pdm,cc0,by,by-sa");
  url.searchParams.set("license_type", "commercial,modification");
  url.searchParams.set("page_size", "20");
  const headers: Record<string, string> = { "User-Agent": UA };
  const token = getSetting("OPENVERSE_TOKEN");
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`Openverse ${resp.status}`);
  const data = (await resp.json()) as {
    results?: { id: string; url?: string; thumbnail?: string; creator?: string; foreign_landing_url?: string; license?: string }[];
  };
  return (data.results ?? [])
    // Drop SVG — ffmpeg's Ken-Burns can't decode it from a .jpg-named file.
    .filter((r) => r.url && !/\.svg(\?|$)/i.test(r.url))
    .map((r): ProviderHit => ({
      kind: "image",
      url: r.url as string,
      dedupeId: `openverse:${r.id}`,
      thumbUrl: r.thumbnail || r.url,
      author: r.creator ?? null,
      sourceUrl: r.foreign_landing_url,
      license: r.license ?? null,
    }));
}

async function wikimediaHits(query: string): Promise<ProviderHit[]> {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", query);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", "20");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|size|mime|extmetadata");
  url.searchParams.set("iiurlwidth", "1920");
  const resp = await fetch(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`Wikimedia ${resp.status}`);
  const data = (await resp.json()) as {
    query?: { pages?: Record<string, { title?: string; imageinfo?: { url?: string; thumburl?: string; mime?: string; descriptionurl?: string; extmetadata?: Record<string, { value?: string }> }[] }> };
  };
  const pages = data.query?.pages ? Object.values(data.query.pages) : [];
  const hits: ProviderHit[] = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!info) continue;
    if (!/^image\//.test(info.mime ?? "")) continue; // stills only (Commons video is webm)
    // Always use the rendered 1920px thumb — it is raster (JPEG/PNG) even when the
    // source is SVG/TIFF, which ffmpeg's Ken-Burns can't decode from raw bytes.
    const u = info.thumburl;
    if (!u) continue;
    hits.push({
      kind: "image",
      url: u,
      dedupeId: `wikimedia:${p.title}`,
      thumbUrl: info.thumburl || u,
      author: info.extmetadata?.Artist?.value?.replace(/<[^>]+>/g, "").slice(0, 120) ?? null,
      sourceUrl: info.descriptionurl,
      license: info.extmetadata?.LicenseShortName?.value ?? null,
    });
  }
  return hits;
}

async function archiveHits(query: string): Promise<ProviderHit[]> {
  const search = new URL("https://archive.org/advancedsearch.php");
  search.searchParams.set("q", `(${query.slice(0, 120)}) AND mediatype:(movies)`);
  search.searchParams.append("fl[]", "identifier");
  search.searchParams.append("fl[]", "title");
  search.searchParams.append("sort[]", "downloads desc");
  search.searchParams.set("rows", "8");
  search.searchParams.set("output", "json");
  const resp = await fetch(search, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`archive.org search ${resp.status}`);
  const data = (await resp.json()) as { response?: { docs?: { identifier?: string }[] } };
  const docs = (data.response?.docs ?? []).filter((d) => d.identifier).slice(0, 3);

  const hits: ProviderHit[] = [];
  for (const d of docs) {
    try {
      const metaResp = await fetch(`https://archive.org/metadata/${encodeURIComponent(d.identifier!)}`, {
        headers: { "User-Agent": UA },
      });
      if (!metaResp.ok) continue;
      const meta = (await metaResp.json()) as {
        files?: { name?: string; size?: string }[];
        metadata?: { licenseurl?: string; creator?: string };
      };
      const mp4s = (meta.files ?? [])
        .filter((f) => f.name?.toLowerCase().endsWith(".mp4") && Number(f.size || 0) > 0 && Number(f.size) < 80 * 1024 * 1024)
        .sort((a, b) => Number(a.size) - Number(b.size));
      const file = mp4s[0];
      if (!file?.name) continue;
      hits.push({
        kind: "video",
        url: `https://archive.org/download/${encodeURIComponent(d.identifier!)}/${encodeURIComponent(file.name)}`,
        dedupeId: `archive:${d.identifier}`,
        thumbUrl: `https://archive.org/services/img/${encodeURIComponent(d.identifier!)}`,
        author: meta.metadata?.creator ?? null,
        sourceUrl: `https://archive.org/details/${encodeURIComponent(d.identifier!)}`,
        license: meta.metadata?.licenseurl ?? "archive.org item license",
      });
    } catch {
      // skip this item
    }
  }
  return hits;
}

/** Which provider names can return the wanted kind. */
const VIDEO_PROVIDERS = new Set(["pexels", "pixabay", "archive"]);
const IMAGE_PROVIDERS = new Set(["pexels", "pixabay", "openverse", "wikimedia"]);

function configuredProviders(want: WantKind): string[] {
  const valid = want === "video" ? VIDEO_PROVIDERS : IMAGE_PROVIDERS;
  const raw = getSetting("FOOTAGE_SOURCES") || "pexels,openverse,wikimedia,archive";
  const list = raw
    .split(/[\n,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => valid.has(s));
  // Default to all valid sources for this kind if the setting is empty/irrelevant.
  return [...new Set(list.length > 0 ? list : [...valid])];
}

async function providerSearch(name: string, query: string, runId: string, want: WantKind, minDurSec: number): Promise<ProviderHit[]> {
  switch (name) {
    case "pexels":
      return pexelsHits(query, runId, want, minDurSec);
    case "pixabay":
      return pixabayHits(query, want, minDurSec);
    case "openverse":
      return want === "image" ? openverseHits(query) : [];
    case "wikimedia":
      return want === "image" ? wikimediaHits(query) : [];
    case "archive":
      return want === "video" ? archiveHits(query) : [];
    default:
      return [];
  }
}

async function gatherCandidates(
  runId: string,
  searchQuery: string,
  want: WantKind,
  minDurSec: number,
  usedIds: Set<string>,
  stage: string
): Promise<ProviderHit[]> {
  const names = configuredProviders(want);
  const lists = await Promise.all(
    names.map(async (name) => {
      const hits = await safe(providerSearch(name, searchQuery, runId, want, minDurSec));
      return hits.slice(0, SOURCE_POOL_PER_PROVIDER).map((h) => ({ ...h, provider: name }));
    })
  );
  const seen = new Set<string>();
  const pool: ProviderHit[] = [];
  for (let i = 0; i < SOURCE_POOL_PER_PROVIDER; i++) {
    for (const list of lists) {
      const h = list[i];
      if (!h || usedIds.has(h.dedupeId) || seen.has(h.dedupeId)) continue;
      seen.add(h.dedupeId);
      pool.push(h);
      if (pool.length >= SOURCE_POOL_MAX) return pool;
    }
  }
  if (pool.length === 0) {
    log(runId, "debug", `No ${want} candidates for "${searchQuery}" across ${names.join(", ")}`, { stage });
  }
  return pool;
}

function hitLabel(h: ProviderHit): string {
  try {
    const p = new URL(h.sourceUrl || "").pathname;
    const slug = p.split("/").filter(Boolean).pop() || "";
    const words = decodeURIComponent(slug).replace(/\.[a-z0-9]+$/i, "").replace(/\d+/g, " ").replace(/[-_]+/g, " ").trim();
    if (words.length > 3) return words;
  } catch {}
  return h.dedupeId.replace(/^[a-z-]+:/, "").replace(/[-_]+/g, " ");
}

function broadenQuery(query: string, level: number): string {
  if (level <= 0) return query;
  const words = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const keep = level === 1 ? 4 : 2;
  return (words.length ? words : query.split(/\s+/)).slice(0, keep).join(" ") || query;
}

async function fetchThumb(url: string): Promise<{ mime: string; data: string } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return null;
    const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!/^image\//.test(mime)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 4 * 1024 * 1024) return null;
    return { mime, data: buf.toString("base64") };
  } catch {
    return null;
  }
}

/** Default relevance threshold (0-100). Reign's confirmed default is 85. */
function threshold(): number {
  return Math.max(0, Math.min(100, Number(getSetting("REAL_MATCH_THRESHOLD") || "85")));
}

/**
 * ONE Gemini-vision call scores every candidate 0-100 by LOOKING at its preview
 * image against the scene + the overall video topic. Returns the best. Fail-open:
 * with no Google key (or any error) returns the first candidate so a run never
 * stalls — but then the threshold check in the caller is effectively bypassed.
 */
async function scoreAndPick(
  runId: string,
  sceneIndex: number,
  sceneQuery: string,
  sceneText: string,
  videoContext: string | undefined,
  pool: ProviderHit[],
  stage: string
): Promise<{ hit: ProviderHit; score: number } | null> {
  if (pool.length === 0) return null;
  const apiKey = getSetting("GOOGLE_API_KEY");
  // Scoring explicitly disabled (threshold 0) → take the first candidate.
  if (threshold() <= 0) return { hit: pool[0], score: 100 };
  // Threshold is set but there's no key to score with → we can't verify
  // relevance, so don't pass off an unscored clip as a match. Report 0 so the
  // caller broadens / falls back to AI (honors the user's relevance bar).
  if (!apiKey) {
    log(runId, "warn", `Scene #${sceneIndex}: REAL_MATCH_THRESHOLD is set but GOOGLE_API_KEY is missing — can't score footage relevance`, { stage });
    return { hit: pool[0], score: 0 };
  }

  const thumbs = await Promise.all(pool.map((h) => (h.thumbUrl ? fetchThumb(h.thumbUrl) : Promise.resolve(null))));

  const parts: ({ text: string } | { inline_data: { mime_type: string; data: string } })[] = [
    {
      text:
        `You are choosing the single best stock clip/photo for ONE scene of a documentary-style video.\n` +
        `OVERALL VIDEO TOPIC: "${(videoContext || sceneText).slice(0, 400)}"\n` +
        `THIS SCENE (narration): "${sceneText.slice(0, 240)}"\n` +
        `WANTED VISUAL: "${sceneQuery}"\n\n` +
        `Below are numbered candidates, each as a title line then its preview image. ` +
        `For EACH, score 0-100 how well the IMAGE itself fits this scene AND stays consistent with the overall video topic ` +
        `(100 = exactly the wanted subject and on-topic; 0 = wrong subject, wrong region, off-topic, or low quality). ` +
        `Judge what you actually SEE, not the title. Return STRICTLY JSON: [{"i":<int>,"score":<int>}]. No markdown.`,
    },
  ];
  pool.forEach((h, i) => {
    parts.push({ text: `[${i}] ${h.kind} from ${h.provider}: ${hitLabel(h)}` });
    const thumb = thumbs[i];
    if (thumb) parts.push({ inline_data: { mime_type: thumb.mime, data: thumb.data } });
  });

  try {
    const model = getSetting("VISION_MATCH_MODEL") || getSetting("SCENE_SPLIT_MODEL") || "gemini-flash-latest";
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    if (!r.ok) throw new Error(`Gemini ${r.status}`);
    const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? text) as { i: number; score: number }[];
    const scored = arr
      .map((x) => ({ hit: pool[Number(x.i)], score: Number(x.score) }))
      .filter((x) => x.hit && Number.isFinite(x.score))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const withThumbs = thumbs.filter(Boolean).length;
    log(
      runId,
      "debug",
      `Scene #${sceneIndex}: scored ${pool.length} candidates (${withThumbs} with image) — best ${best ? best.score : "n/a"}/${threshold()} (${best ? best.hit.provider : "—"})`,
      { stage }
    );
    return best ?? { hit: pool[0], score: 0 };
  } catch (e) {
    // A transient scoring error must NOT bypass the relevance bar — report 0 so
    // the caller broadens the search or falls back to AI instead of silently
    // using an unverified clip.
    log(runId, "warn", `Scene #${sceneIndex}: relevance scoring failed (${(e as Error).message.slice(0, 80)}) — not accepting unscored footage`, { stage });
    return { hit: pool[0], score: 0 };
  }
}

function sceneQuery(scene: Scene): string {
  return visualPromptToQuery(scene.real_image_query || scene.visual_prompt || scene.text || "");
}

export interface ScoredFootageOptions {
  runId: string;
  want: WantKind;
  /** Desired clip length (video only — prefer clips covering the scene). */
  durSec?: number;
  /** One-line topic of the whole video — anchors relevance scoring to context. */
  videoContext?: string;
}

/**
 * Search every enabled footage source for a scene, score the candidates with
 * Gemini Vision, and download the best match (≥ REAL_MATCH_THRESHOLD). Broadens
 * the query for up to 3 attempts. Returns the downloaded file + metadata, or
 * `null` when nothing clears the bar (the pipeline then falls back to AI).
 *
 * For want="image" the raw photo is downloaded to outPath (the pipeline's
 * assembly applies Ken Burns with the scene audio). For want="video" the clip
 * is downloaded as-is.
 */
export async function acquireScoredFootage(
  scene: Scene,
  outPath: string,
  usedIds: Set<string>,
  opts: ScoredFootageOptions
): Promise<ScoredFootage | null> {
  const { runId, want, durSec = 0, videoContext } = opts;
  const stage = want === "video" ? "animate" : "image";
  const query = sceneQuery(scene);
  if (!query) {
    log(runId, "warn", `Scene #${scene.index}: empty footage query (no real_image_query / visual_prompt)`, { stage });
    return null;
  }
  const bar = threshold();

  for (let attempt = 0; attempt < 3; attempt++) {
    const searchQuery = broadenQuery(query, attempt);
    if (attempt > 0) {
      log(runId, "info", `Scene #${scene.index}: best ${want} match below ${bar}% — retry ${attempt}/2 (broader: "${searchQuery}")`, { stage });
    }
    const pool = await gatherCandidates(runId, searchQuery, want, durSec, usedIds, stage);
    if (pool.length === 0) continue;
    const best = await scoreAndPick(runId, scene.index, query, scene.text ?? "", videoContext, pool, stage);
    if (!best || best.score < bar) continue;
    usedIds.add(best.hit.dedupeId);
    try {
      await downloadToFile(best.hit.url, outPath);
      log(
        runId,
        "info",
        `Scene #${scene.index}: real ${best.hit.kind} via ${best.hit.provider} — relevance ${best.score}% [${searchQuery}]`,
        { stage, data: { provider: best.hit.provider, score: best.score, sourceUrl: best.hit.sourceUrl } }
      );
      return {
        path: outPath,
        kind: best.hit.kind,
        provider: best.hit.provider ?? "real",
        matchScore: best.score,
        attribution: { author: best.hit.author, sourceUrl: best.hit.sourceUrl, license: best.hit.license },
      };
    } catch (e) {
      // Release the claim so another scene can try it, then retry/broaden.
      usedIds.delete(best.hit.dedupeId);
      log(runId, "debug", `Scene #${scene.index}: best pick failed to download (${(e as Error).message.slice(0, 100)})`, { stage });
    }
  }
  log(runId, "info", `Scene #${scene.index}: no ${want} cleared ${bar}% after 3 attempts — falling back`, { stage });
  return null;
}

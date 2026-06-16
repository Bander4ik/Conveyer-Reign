import fs from "node:fs";
import path from "node:path";

/**
 * Upload a local image to a public host so the image/video models can fetch it
 * as a reference.
 *
 * 69labs `/images/generate` and kie's Veo image-to-video both accept reference
 * images only as public http(s) URLs (no upload endpoint, no base64 data URIs).
 * So a reference frame — a character portrait, or a shot's continuity anchor —
 * has to live at a reachable URL first.
 *
 * We use litterbox (catbox's *temporary* host) with a 72h expiry: references are
 * only needed for the few minutes a run takes, and auto-expiry means we don't
 * accumulate uploaded frames on a permanent public host.
 *
 * Reliability: litterbox is unauthenticated and rate-limits under load, and a
 * big run uploads a lot (every continuity anchor + every kie img2vid frame). So
 * we (a) RETRY a few times, and (b) CACHE by file identity so the same frame —
 * which is uploaded by BOTH the anchor step and the kie img2vid step — is only
 * sent once.
 */
const LITTERBOX_API = "https://litterbox.catbox.moe/resources/internals/api.php";
const UPLOAD_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
// Don't reuse a minted URL forever — we request a 72h expiry, so cap the cache
// well under that to avoid ever handing back a link that has expired on a
// long-lived dev server.
const CACHE_TTL_MS = 60 * 60 * 1000;
const uploadCache = new Map<string, { url: string; at: number }>();

async function uploadOnce(buf: Buffer, name: string): Promise<string> {
  const fd = new FormData();
  fd.append("reqtype", "fileupload");
  fd.append("time", "72h");
  // Wrap in a fresh Uint8Array so the Blob part is ArrayBuffer-backed (a typed
  // Buffer param can widen to ArrayBufferLike, which Blob rejects).
  fd.append("fileToUpload", new Blob([new Uint8Array(buf)]), name);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const r = await fetch(LITTERBOX_API, { method: "POST", body: fd, signal: ctrl.signal });
    const text = (await r.text()).trim();
    if (!r.ok || !/^https?:\/\//i.test(text)) {
      throw new Error(`litterbox upload failed (${r.status}): ${text.slice(0, 160)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function uploadPublicImage(localPath: string): Promise<string> {
  if (!fs.existsSync(localPath)) throw new Error(`reference image not found: ${localPath}`);
  const st = fs.statSync(localPath);
  // Key by path + mtime + size: re-uploading the SAME bytes (anchor frame reused
  // for kie img2vid) hits the cache, but a regenerated file (new mtime) misses
  // and re-uploads, so a stale URL is never served.
  const key = `${path.resolve(localPath)}:${st.mtimeMs}:${st.size}`;
  const cached = uploadCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.url;

  const buf = fs.readFileSync(localPath);
  const name = path.basename(localPath) || "ref.png";

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const url = await uploadOnce(buf, name);
      uploadCache.set(key, { url, at: Date.now() });
      return url;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

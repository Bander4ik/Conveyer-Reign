import fs from "node:fs";
import { getSetting } from "../settings";
import { log } from "../logger";

/**
 * kie.ai API client — alternative backend to 69labs for images, video and TTS.
 *
 * Two API families (docs.kie.ai):
 *  - Market "Jobs" API (images, TTS):
 *      POST /api/v1/jobs/createTask        { model, input } → { data: { taskId } }
 *      GET  /api/v1/jobs/recordInfo?taskId → { data: { state, resultJson, failMsg } }
 *      state: "success" | "fail" | (anything else = still working)
 *      resultJson is a JSON STRING: {"resultUrls":["https://..."]}
 *  - Veo3 video API:
 *      POST /api/v1/veo/generate           { prompt, model, imageUrls, ... } → { data: { taskId } }
 *      GET  /api/v1/veo/record-info?taskId → { data: { successFlag, response: { resultUrls }, errorMessage } }
 *      successFlag: 0 generating · 1 success · 2/3 failed
 *
 * Auth: Authorization: Bearer KIE_API_KEY. 429s are rejected (not queued) — we
 * wait and retry. Result files live on kie's CDN for ~14 days; we download
 * immediately into the run folder.
 *
 * Model-name mapping lives here so users can switch 69labs ↔ kie WITHOUT
 * touching IMAGE_MODEL / ANIMATION_MODEL — the same settings keep working.
 */

const BASE = "https://api.kie.ai";
const POLL_INTERVAL_MS = 2500;
const STALL_MAX_MS = 8 * 60 * 1000; // no state change for this long → give up
const HARD_CAP_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_RATE_RETRIES = 20;

function apiKey(): string {
  const k = getSetting("KIE_API_KEY").trim();
  if (!k) throw new Error("KIE_API_KEY is not set — add it in Settings (get one at kie.ai → API Keys)");
  return k;
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(init ?? {}), signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code || cause?.message || (e as Error).message;
    throw new Error(`network error contacting kie.ai: ${detail}`);
  } finally {
    clearTimeout(t);
  }
}

/** POST JSON with 429 wait-and-retry and clear 401 messaging. */
async function postJson<T>(
  path: string,
  body: unknown,
  ctx?: { runId: string; stage: string }
): Promise<T> {
  const key = apiKey();
  let rateRetry = 0;
  while (true) {
    const r = await fetchWithTimeout(`${BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const json = (await r.json()) as { code?: number; msg?: string } & T;
      // kie returns HTTP 200 with an application-level code for some errors.
      if (typeof json.code === "number" && json.code !== 200) {
        if (json.code === 429 && rateRetry < MAX_RATE_RETRIES) {
          rateRetry++;
          if (ctx) {
            log(ctx.runId, "warn", `kie.ai rate limit — waiting 15s then retrying (${rateRetry}/${MAX_RATE_RETRIES})`, {
              stage: ctx.stage,
            });
          }
          await sleep(15_000);
          continue;
        }
        throw new Error(`kie.ai POST ${path} code ${json.code}: ${(json.msg || "").slice(0, 300)}`);
      }
      return json;
    }
    if (r.status === 429 && rateRetry < MAX_RATE_RETRIES) {
      rateRetry++;
      const retryAfter = Number(r.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 120_000) : 15_000;
      if (ctx) {
        log(ctx.runId, "warn", `kie.ai rate limit (429) — waiting ${Math.round(waitMs / 1000)}s then retrying (${rateRetry}/${MAX_RATE_RETRIES})`, {
          stage: ctx.stage,
        });
      }
      await sleep(waitMs);
      continue;
    }
    if (r.status === 401) {
      throw new Error(`kie.ai POST ${path} 401 Unauthorized — KIE_API_KEY is invalid. Check it in Settings.`);
    }
    throw new Error(`kie.ai POST ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
}

// ── Market Jobs API (images, TTS) ───────────────────────────────────────────

/** Create a Market-model task. Returns taskId. */
export async function createKieTask(
  model: string,
  input: Record<string, unknown>,
  ctx?: { runId: string; stage: string }
): Promise<string> {
  const json = await postJson<{ data?: { taskId?: string } }>("/api/v1/jobs/createTask", { model, input }, ctx);
  const taskId = json.data?.taskId;
  if (!taskId) throw new Error(`kie.ai createTask returned no taskId (model ${model})`);
  return taskId;
}

/** Poll a Market task until success/fail. Returns the result URLs. */
export async function pollKieTask(taskId: string, runId: string, stage: string): Promise<string[]> {
  const key = apiKey();
  const start = Date.now();
  let lastState = "";
  let lastProgressAt = start;
  while (true) {
    const r = await fetchWithTimeout(`${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`kie.ai recordInfo ${taskId} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const json = (await r.json()) as {
      data?: { state?: string; resultJson?: string; failMsg?: string; failCode?: string };
    };
    const state = (json.data?.state || "").toLowerCase();
    if (state !== lastState) {
      lastProgressAt = Date.now();
      log(runId, "debug", `kie task ${taskId.slice(0, 12)}… → ${state || "pending"}`, { stage });
      lastState = state;
    }
    if (state === "success") {
      try {
        const parsed = JSON.parse(json.data?.resultJson || "{}") as { resultUrls?: string[] };
        const urls = parsed.resultUrls ?? [];
        if (urls.length === 0) throw new Error("empty resultUrls");
        return urls;
      } catch (e) {
        throw new Error(`kie.ai task ${taskId} succeeded but the result is unreadable: ${(e as Error).message}`);
      }
    }
    if (state === "fail") {
      throw new Error(`kie.ai task ${taskId} failed: ${json.data?.failMsg || json.data?.failCode || "unknown reason"}`);
    }
    if (Date.now() - lastProgressAt > STALL_MAX_MS) {
      throw new Error(`kie.ai task ${taskId} stalled — no progress for ${STALL_MAX_MS / 1000}s (state ${state || "pending"})`);
    }
    if (Date.now() - start > HARD_CAP_MS) {
      throw new Error(`kie.ai task ${taskId} exceeded ${HARD_CAP_MS / 60000}min hard cap`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ── Veo3 video API ──────────────────────────────────────────────────────────

/** Map our ANIMATION_MODEL values onto kie's Veo model ids. */
export function kieVeoModel(animationModel: string): string {
  const m = animationModel.trim().toLowerCase();
  if (m === "veo3" || m === "veo3_fast" || m === "veo3_lite") return m;
  if (/lite/.test(m)) return "veo3_lite";
  if (/fast/.test(m)) return "veo3_fast";
  if (/^veo/.test(m) || m === "" ) return "veo3_fast"; // 69labs "veo-video" etc.
  return "veo3_fast";
}

/** Create a Veo video task (text-to-video, or image-to-video when imageUrl given). */
export async function createKieVeoTask(opts: {
  prompt: string;
  imageUrl?: string;
  model?: string;
  aspectRatio?: string;
  durationSec?: number;
  runId: string;
}): Promise<string> {
  const aspect = opts.aspectRatio === "9:16" ? "9:16" : "16:9"; // kie veo accepts 16:9 | 9:16 | Auto
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    model: kieVeoModel(opts.model || ""),
    aspect_ratio: aspect,
  };
  if (opts.imageUrl) {
    body.imageUrls = [opts.imageUrl];
    body.generationType = "FIRST_AND_LAST_FRAMES_2_VIDEO"; // 1 image = animate from this frame
  } else {
    body.generationType = "TEXT_2_VIDEO";
  }
  if (opts.durationSec) {
    // kie accepts 4 | 6 | 8 — snap to the nearest allowed value.
    const allowed = [4, 6, 8];
    body.duration = allowed.reduce((a, b) => (Math.abs(b - opts.durationSec!) < Math.abs(a - opts.durationSec!) ? b : a));
  }
  const json = await postJson<{ data?: { taskId?: string }; taskId?: string }>(
    "/api/v1/veo/generate",
    body,
    { runId: opts.runId, stage: "animate" }
  );
  const taskId = json.data?.taskId ?? json.taskId;
  if (!taskId) throw new Error("kie.ai veo/generate returned no taskId");
  return taskId;
}

/** Poll a Veo task until done. Returns the video URL. */
export async function pollKieVeo(taskId: string, runId: string): Promise<string> {
  const key = apiKey();
  const start = Date.now();
  let lastFlag = -1;
  let lastProgressAt = start;
  while (true) {
    const r = await fetchWithTimeout(`${BASE}/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`kie.ai veo/record-info ${taskId} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const json = (await r.json()) as {
      data?: { successFlag?: number; response?: { resultUrls?: string[] }; errorMessage?: string; errorCode?: string | null };
    };
    const flag = json.data?.successFlag ?? 0;
    if (flag !== lastFlag) {
      lastProgressAt = Date.now();
      log(runId, "debug", `kie veo ${taskId.slice(0, 12)}… → flag ${flag}`, { stage: "animate" });
      lastFlag = flag;
    }
    if (flag === 1) {
      const url = json.data?.response?.resultUrls?.[0];
      if (!url) throw new Error(`kie.ai veo task ${taskId} succeeded but returned no video URL`);
      return url;
    }
    if (flag === 2 || flag === 3) {
      throw new Error(`kie.ai veo task ${taskId} failed: ${json.data?.errorMessage || `flag ${flag}`}`);
    }
    if (Date.now() - lastProgressAt > STALL_MAX_MS) {
      throw new Error(`kie.ai veo task ${taskId} stalled — no progress for ${STALL_MAX_MS / 1000}s`);
    }
    if (Date.now() - start > HARD_CAP_MS) {
      throw new Error(`kie.ai veo task ${taskId} exceeded ${HARD_CAP_MS / 60000}min hard cap`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Download a result file from kie's CDN into the run folder. */
export async function downloadKieFile(url: string, outPath: string): Promise<void> {
  const r = await fetchWithTimeout(url, { redirect: "follow" }, DOWNLOAD_TIMEOUT_MS);
  if (!r.ok) throw new Error(`kie.ai download ${r.status} for ${url.slice(0, 80)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length === 0) throw new Error("kie.ai download returned an empty file");
  fs.writeFileSync(outPath, buf);
}

/** Map our IMAGE_MODEL values onto kie's Market model ids. */
export function kieImageModel(imageModel: string): string {
  const m = imageModel.trim().toLowerCase();
  if (!m || m === "nano-banana-pro") return "nano-banana-pro";
  if (m === "nano-banana") return "google/nano-banana";
  // Anything else (imagen-4, seedream-4.5, flux…) — pass through; kie will say
  // clearly if it doesn't host that model id.
  return imageModel.trim();
}

/** kie wants "1K"/"2K"/"4K" (uppercase); our setting stores "1k"/"2k"/"4k". */
export function kieResolution(res: string): string | undefined {
  const m = /^([124])k$/i.exec(res.trim());
  return m ? `${m[1]}K` : undefined;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

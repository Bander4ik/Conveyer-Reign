import ffmpeg from "fluent-ffmpeg";
import { getSetting } from "../settings";
import { log } from "../logger";
import { drawtextFont, escDrawtext } from "./fonts";

/**
 * Battle data mode — builds an intro "VS" stat-comparison card for matchup
 * videos (e.g. honey badger vs cobra). The two fighters and their stats are
 * extracted from the script by Gemini; the card itself is rendered with FFmpeg
 * drawtext so the numbers are exact (no model text-rendering errors).
 *
 * Everything here is best-effort: any failure is caught by the caller and the
 * run continues without a card.
 */

export interface Stat {
  label: string;
  value: string;
}
export interface Fighter {
  name: string;
  stats: Stat[];
}
export interface Matchup {
  title: string;
  left: Fighter;
  right: Fighter;
}

export const CARD_DURATION_SEC = 5;

function applyFfmpegPath(): void {
  const ffmpegPath = getSetting("FFMPEG_PATH");
  if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
}

/** Ask Gemini to pull the two combatants + a few real-ish stats from the script. */
export async function extractMatchup(runId: string, script: string): Promise<Matchup | null> {
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) return null;
  const model = getSetting("SCENE_SPLIT_MODEL") || "gemini-flash-latest";

  const system =
    "You analyze a short script for a faceless 'matchup' YouTube video (two animals, " +
    "creatures, fighters, or things compared head to head). Identify the TWO main " +
    "combatants. For each, give 3 to 5 comparable stats using widely-cited approximate " +
    "real-world figures WITH units (e.g. Weight, Length, Bite force, Top speed, Venom/Toxicity, " +
    "Strength). Both fighters must use the SAME stat labels in the same order so they line up. " +
    'Return STRICT JSON: {"title": string, "left": {"name": string, "stats": [{"label": string, "value": string}]}, ' +
    '"right": {"name": string, "stats": [{"label": string, "value": string}]}}. ' +
    "If the script is NOT a head-to-head matchup, return {\"title\":\"\"} with empty fighters.";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: `Script:\n\n${script.slice(0, 12000)}` }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.4,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!resp.ok) {
      log(runId, "warn", `Battle stats: Gemini ${resp.status} — skipping card`, { stage: "battle" });
      return null;
    }
    const json = (await resp.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const parsed = JSON.parse(text) as Partial<Matchup>;
    const left = sanitizeFighter(parsed.left);
    const right = sanitizeFighter(parsed.right);
    if (!left || !right) {
      log(runId, "info", "Battle stats: script isn't a clear matchup — no card", { stage: "battle" });
      return null;
    }
    return { title: String(parsed.title || `${left.name} vs ${right.name}`), left, right };
  } catch (e) {
    log(runId, "warn", `Battle stats extraction failed: ${(e as Error).message.slice(0, 160)}`, {
      stage: "battle",
    });
    return null;
  }
}

function sanitizeFighter(f: unknown): Fighter | null {
  if (!f || typeof f !== "object") return null;
  const o = f as { name?: unknown; stats?: unknown };
  const name = String(o.name ?? "").trim();
  if (!name) return null;
  const stats: Stat[] = Array.isArray(o.stats)
    ? o.stats
        .map((s) => {
          const so = (s ?? {}) as { label?: unknown; value?: unknown };
          return { label: String(so.label ?? "").trim(), value: String(so.value ?? "").trim() };
        })
        .filter((s) => s.label && s.value)
        .slice(0, 5)
    : [];
  if (stats.length === 0) return null;
  return { name, stats };
}

/**
 * Render the VS stat card as a single PNG (w×h) via FFmpeg drawtext.
 * Generous margins so the assembly's static display never crops the text.
 */
export function renderStatCard(matchup: Matchup, outPath: string, w: number, h: number): Promise<void> {
  applyFfmpegPath();
  const font = drawtextFont();
  if (!font) throw new Error("no usable system font for the stat card");
  const leftX = `(w/2-text_w)/2`;
  const rightX = `w/2+(w/2-text_w)/2`;
  const dt = (text: string, x: string, y: number, size: number, color: string) =>
    `drawtext=fontfile=${font}:text='${escDrawtext(text)}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}`;

  const filters: string[] = [
    // center divider
    `drawbox=x=w/2-1:y=${Math.round(h * 0.22)}:w=2:h=${Math.round(h * 0.5)}:color=0x2a2c33:t=fill`,
    dt(matchup.title, `(w-text_w)/2`, Math.round(h * 0.09), Math.round(h / 15), "0xffffff"),
    dt("VS", `(w-text_w)/2`, Math.round(h * 0.44), Math.round(h / 9), "0xe23636"),
    dt(matchup.left.name, leftX, Math.round(h * 0.25), Math.round(h / 18), "0xffffff"),
    dt(matchup.right.name, rightX, Math.round(h * 0.25), Math.round(h / 18), "0xffffff"),
  ];
  const statSize = Math.round(h / 30);
  const statTop = Math.round(h * 0.4);
  const lineH = Math.round(h * 0.075);
  matchup.left.stats.forEach((s, i) => {
    filters.push(dt(`${s.label} - ${s.value}`, leftX, statTop + i * lineH, statSize, "0xcfd2da"));
  });
  matchup.right.stats.forEach((s, i) => {
    filters.push(dt(`${s.label} - ${s.value}`, rightX, statTop + i * lineH, statSize, "0xcfd2da"));
  });

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(`color=c=0x0e0f13:s=${w}x${h}`)
      .inputOptions(["-f lavfi"])
      .videoFilters(filters)
      .outputOptions(["-frames:v 1"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

/** A silent mp3 of the given length — gives the card clip its on-screen duration. */
export function makeSilentAudio(outPath: string, durationSec: number): Promise<void> {
  applyFfmpegPath();
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input("anullsrc=r=44100:cl=stereo")
      .inputOptions(["-f lavfi"])
      .outputOptions([`-t ${durationSec}`, "-c:a libmp3lame", "-q:a 9"])
      .on("error", reject)
      .on("end", () => resolve())
      .save(outPath);
  });
}

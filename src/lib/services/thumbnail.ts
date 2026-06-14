import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { getSetting, geminiModel } from "../settings";
import { log } from "../logger";
import { generateImageToPath } from "./image-gen";

/**
 * Thumbnail generator.
 *
 * Flow (what Reign asked for): the channel holds ONE "master prompt" (style /
 * recipe). For each run, the LLM (the scene-split provider — Claude or Gemini)
 * reads the master prompt + the video title + the WHOLE script and writes a
 * concrete thumbnail image-prompt for THAT specific video. Then the image
 * provider generates N variations (THUMBNAIL_COUNT, 3-5) to choose from.
 *
 * Best-effort: a thumbnail failure never fails the run (the video is already
 * done by the time this runs).
 */

/** Provider-aware plain-text LLM call (Claude or Gemini), used to write the
 *  per-video thumbnail prompt. */
async function askLLM(system: string, user: string): Promise<string> {
  const provider = (getSetting("SCENE_SPLIT_PROVIDER") || "google").toLowerCase();

  if (provider === "anthropic") {
    const apiKey = getSetting("ANTHROPIC_API_KEY");
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: getSetting("SCENE_SPLIT_MODEL") || "claude-sonnet-4-6",
      max_tokens: 1000,
      system,
      messages: [{ role: "user", content: user }],
    });
    return resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("\n")
      .trim();
  }

  // Gemini (default) — geminiModel() keeps this a Gemini id even if the LLM
  // selection is Claude (this endpoint only accepts Gemini models).
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set");
  const model = geminiModel();
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }
  );
  if (!r.ok) throw new Error(`Gemini ${r.status}`);
  const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return (j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "").trim();
}

/** Turn the channel's master prompt + title + script into a concrete, single
 *  thumbnail image prompt for this video. */
async function buildThumbnailPrompt(title: string, script: string, masterPrompt: string): Promise<string> {
  const system =
    "You are a YouTube thumbnail art director for a faceless channel. Given the video TITLE, the full SCRIPT, " +
    "and the channel's MASTER STYLE, write ONE vivid image-generation prompt (40-90 words) for a single, " +
    "scroll-stopping 16:9 thumbnail that captures the video's main subject and its emotional hook. " +
    "Follow the master style. Make it photoreal unless the master style says otherwise, with bold dramatic " +
    "lighting and strong focal subject. Do NOT include any on-image text, captions, logos or watermarks. " +
    "Return ONLY the image prompt — no preamble, no quotes, no markdown.";
  const user =
    `TITLE: ${title || "(untitled)"}\n\n` +
    `MASTER STYLE:\n${masterPrompt}\n\n` +
    `SCRIPT:\n${script.slice(0, 12000)}`;
  const out = (await askLLM(system, user)).replace(/^["'`]+|["'`]+$/g, "").trim();
  // Fallback to the master prompt + title if the LLM returns nothing usable.
  return out || `${masterPrompt}. ${title}`.trim();
}

/**
 * Generate `count` thumbnail options into `<runDir>/thumbnails/`. Returns the
 * filenames created (e.g. ["thumb_1.png", ...]). Never throws — logs and returns
 * what it managed to make.
 */
export async function generateThumbnails(opts: {
  runId: string;
  title: string;
  script: string;
  masterPrompt: string;
  runDir: string;
  count: number;
}): Promise<string[]> {
  const { runId, title, script, masterPrompt, runDir } = opts;
  const count = Math.max(1, Math.min(5, Math.floor(opts.count) || 4));
  const dir = path.join(runDir, "thumbnails");

  let basePrompt: string;
  try {
    basePrompt = await buildThumbnailPrompt(title, script, masterPrompt);
    log(runId, "info", `Thumbnail concept ready — generating ${count} option(s)`, {
      stage: "thumbnail",
      data: { prompt: basePrompt.slice(0, 160) },
    });
  } catch (e) {
    log(runId, "warn", `Thumbnail prompt failed (${(e as Error).message.slice(0, 140)}) — skipping thumbnails`, {
      stage: "thumbnail",
    });
    return [];
  }

  fs.mkdirSync(dir, { recursive: true });
  const noText = "no text, no captions, no title, no words, no logo, no watermark";
  const finish = "Eye-catching YouTube thumbnail, bold dramatic lighting, high contrast, sharp focus, clear focal subject.";

  const made: string[] = [];
  for (let i = 0; i < count; i++) {
    // Nudge each generation toward a different composition so the options vary.
    const variant = i === 0 ? "" : ` Alternative composition and camera angle (option ${i + 1}).`;
    const full = `${basePrompt}.${variant} ${finish} ${noText}`;
    const file = `thumb_${i + 1}.png`;
    try {
      await generateImageToPath(runId, full, path.join(dir, file));
      made.push(file);
      log(runId, "success", `Thumbnail option ${i + 1}/${count} generated`, { stage: "thumbnail" });
    } catch (e) {
      log(runId, "warn", `Thumbnail option ${i + 1} failed: ${(e as Error).message.slice(0, 140)}`, {
        stage: "thumbnail",
      });
    }
  }
  if (made.length > 0) {
    log(runId, "success", `Thumbnails ready: ${made.length}/${count}`, { stage: "thumbnail", data: { thumbnails: made } });
  }
  return made;
}

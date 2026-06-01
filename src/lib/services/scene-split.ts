import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { getPrompt } from "../prompts";
import { log } from "../logger";
import { getRunDir } from "../run-paths";

export interface Scene {
  index: number;
  text: string;
  visual_prompt: string;
  duration_hint_sec: number;
  /** Names of the cast members visually present in this scene (for character
   *  consistency). Empty/absent when the scene has no defined characters. */
  characters?: string[];
}

/** A character the script splitter should tag scenes with. */
export interface CastMember {
  name: string;
  description?: string;
  isHost?: boolean;
}

/**
 * Appended to the scene-split system prompt when the run defines characters.
 * Tells the model to tag each scene with which cast members appear in it, so
 * the image stage can lock those scenes to a consistent reference image.
 */
function buildCastSuffix(cast: CastMember[]): string {
  if (!cast || cast.length === 0) return "";
  const list = cast
    .map(
      (c) =>
        `- "${c.name}"${c.isHost ? " (host / on-camera presenter)" : ""}: ${
          c.description?.trim() || "as defined by the user"
        }`
    )
    .join("\n");
  return `

── RECURRING CHARACTERS IN THIS VIDEO ──
This video features these named characters:
${list}

For EVERY scene object you output, ALSO include a "characters" field: a JSON array of the NAMES (copied EXACTLY as written above, including capitalization) of any of these characters who are visually depicted in that scene. Use an empty array [] when none of them appear. A character "appears" when the scene's visual would actually show that specific person. Treat the host / presenter as appearing whenever the narration is them addressing the viewer or the script focuses on them. Never put a name in "characters" that is not in the list above.`;
}

/**
 * Chunk threshold for scene-split.
 *
 * Gemini 2.5 Flash/Pro caps output at 65 535 tokens. A scene-split JSON
 * entry averages ~180 tokens (text + 60–120-word visual_prompt + duration),
 * so a 3 000-word script → ~300 scenes → ~54 K output — we are then
 * uncomfortably close to the hard cap. Anything longer we split into
 * ≤ 3 000-word chunks at SENTENCE boundaries and scene-split each chunk
 * separately, then concatenate. The pipeline downstream (TTS, video,
 * assembly) is unaware any chunking happened.
 *
 * Why sentence boundaries: the LLM never sees a half-sentence at the seam,
 * so coverage stays clean and no scene is born torn-in-two.
 */
const WORDS_PER_CHUNK = 3000;

/**
 * Splits the script into scenes. Supports Google Gemini (default, cheap) and
 * Anthropic Claude. Scripts longer than ~3 000 words (≈ 20–25 min of
 * narration) are automatically chunked — no manual intervention needed.
 */
export async function splitScript(
  runId: string,
  script: string,
  cast: CastMember[] = []
): Promise<Scene[]> {
  const provider = (getSetting("SCENE_SPLIT_PROVIDER") || "google").toLowerCase();
  const systemPrompt = getPrompt("scene_split") + buildCastSuffix(cast);

  const totalWords = script.trim().split(/\s+/).filter(Boolean).length;
  log(runId, "info", `Splitting script (${provider}) — ${totalWords} words`, {
    stage: "scene_split",
    data: { scriptChars: script.length, totalWords },
  });

  let allScenes: Scene[];

  if (totalWords <= WORDS_PER_CHUNK) {
    // Small enough for one pass.
    allScenes = await splitOneChunk(runId, provider, systemPrompt, script, 0);
  } else {
    // Long script — split at sentence boundaries and scene-split each chunk.
    const chunks = chunkScript(script, WORDS_PER_CHUNK);
    log(
      runId,
      "info",
      `Script is too long for one ${provider} call (over ${WORDS_PER_CHUNK} words) — ` +
        `splitting into ${chunks.length} chunks for scene_split`,
      { stage: "scene_split", data: { chunkCount: chunks.length, totalWords } }
    );

    allScenes = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkWords = chunks[i].trim().split(/\s+/).filter(Boolean).length;
      log(
        runId,
        "info",
        `Scene-splitting chunk ${i + 1}/${chunks.length} (${chunkWords} words)`,
        { stage: "scene_split" }
      );
      const chunkScenes = await splitOneChunk(
        runId,
        provider,
        systemPrompt,
        chunks[i],
        allScenes.length
      );
      allScenes.push(...chunkScenes);
    }
  }

  // Coverage check — words in scene.text vs original script. <70% means the
  // model summarized; we warn but still return what we got.
  const sceneWords = allScenes.reduce(
    (sum, s) => sum + s.text.trim().split(/\s+/).filter(Boolean).length,
    0
  );
  const coverage = totalWords > 0 ? (sceneWords / totalWords) * 100 : 0;

  log(
    runId,
    "success",
    `Done: ${allScenes.length} scenes · script coverage ${coverage.toFixed(0)}% (${sceneWords}/${totalWords} words)`,
    {
      stage: "scene_split",
      data: { scenes: allScenes.slice(0, 5).map((s) => ({ i: s.index, text: s.text.slice(0, 60) })) },
    }
  );

  if (coverage < 70) {
    log(
      runId,
      "warn",
      `⚠️ Low coverage (${coverage.toFixed(0)}%) — the model likely summarized the script. Review the scene_split prompt on /prompts.`,
      { stage: "scene_split" }
    );
  }

  return allScenes;
}

/**
 * Sends one chunk of script to the configured LLM and returns its scenes,
 * re-indexed starting at `sceneIndexOffset` so they line up inside the
 * full-script scene array.
 */
async function splitOneChunk(
  runId: string,
  provider: string,
  systemPrompt: string,
  scriptChunk: string,
  sceneIndexOffset: number
): Promise<Scene[]> {
  let raw: string;
  if (provider === "google") {
    raw = await splitWithGemini(systemPrompt, scriptChunk);
  } else if (provider === "anthropic") {
    raw = await splitWithClaude(systemPrompt, scriptChunk);
  } else {
    throw new Error(`Unknown SCENE_SPLIT_PROVIDER: ${provider}`);
  }

  let json: unknown;
  try {
    json = extractJson(raw);
  } catch (e) {
    // Save raw output so we can see what went wrong — one file per chunk so
    // chunks don't overwrite each other's dumps.
    try {
      const runDir = getRunDir(runId);
      fs.mkdirSync(runDir, { recursive: true });
      const filename = `scene_split_raw_${sceneIndexOffset}.txt`;
      fs.writeFileSync(path.join(runDir, filename), raw, "utf-8");
      log(runId, "error", `Raw output saved to ${runDir}/${filename} (${raw.length} chars)`, {
        stage: "scene_split",
      });
    } catch {}
    throw e;
  }
  if (!Array.isArray(json)) {
    log(runId, "error", "LLM did not return an array", {
      stage: "scene_split",
      data: { raw: raw.slice(0, 500) },
    });
    throw new Error("scene_split: model did not return a JSON array");
  }

  return json.map((s, i) => ({
    index: sceneIndexOffset + i,
    text: String(s.text ?? ""),
    visual_prompt: String(s.visual_prompt ?? ""),
    duration_hint_sec: Number(s.duration_hint_sec ?? 6),
    characters: Array.isArray(s.characters)
      ? s.characters.map((x: unknown) => String(x)).filter(Boolean)
      : [],
  }));
}

/**
 * Splits a script into chunks at sentence boundaries, targeting `targetWords`
 * per chunk. A "sentence" is anything up to a `.`, `!` or `?`.
 *
 * If the script has no sentence terminators we return it whole — bad chunking
 * is worse than no chunking, and the only way to get here is a script written
 * without punctuation, which won't scene-split well anyway.
 */
function chunkScript(script: string, targetWords: number): string[] {
  const sentenceRegex = /[^.!?]+[.!?]+["')\]]*\s*/g;
  const matches = script.match(sentenceRegex);
  if (!matches || matches.length === 0) return [script];

  // If the regex didn't consume the trailing characters (e.g. a final
  // sentence without a terminator), append the leftover so we cover 100%
  // of the script.
  const sentences: string[] = [...matches];
  const captured = matches.join("");
  if (captured.length < script.length) {
    sentences.push(script.slice(captured.length));
  }

  const chunks: string[] = [];
  let current = "";
  let currentWords = 0;
  for (const sent of sentences) {
    const sentWords = sent.trim().split(/\s+/).filter(Boolean).length;
    if (currentWords > 0 && currentWords + sentWords > targetWords) {
      chunks.push(current.trim());
      current = "";
      currentWords = 0;
    }
    current += sent;
    currentWords += sentWords;
  }
  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks;
}

async function splitWithGemini(systemPrompt: string, script: string): Promise<string> {
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set (Settings)");
  const model = getSetting("SCENE_SPLIT_MODEL") || "gemini-flash-latest";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: `Script:\n\n${script}` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.7,
      // 65535 — Gemini 2.5 Flash/Pro hard max for output. Per-chunk we target
      // ~3 000 words of input → ~54 K of output, leaving an 11 K-token buffer
      // before the hard cap. Anything that still overflows surfaces below
      // with a clear "split the script" message.
      maxOutputTokens: 65535,
      // Disable thinking — for structured output it just wastes the token budget
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  // Retry with exponential backoff for transient errors
  // (503 UNAVAILABLE / 429 RATE_LIMIT / 500 — common Google API blips)
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const MAX_RETRIES = 4;
  let attempt = 0;
  let lastErr = "";

  while (attempt <= MAX_RETRIES) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (resp.ok) {
      const json = (await resp.json()) as {
        candidates?: {
          content?: { parts?: { text?: string }[] };
          finishReason?: string;
        }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
      };
      const cand = json.candidates?.[0];
      const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const reason = cand?.finishReason;
      if (reason && reason !== "STOP") {
        throw new Error(
          `Gemini finish=${reason} (output cut off, tokens=${json.usageMetadata?.candidatesTokenCount}). ` +
            `Even a single ~3 000-word chunk produced more than Gemini's 65 535-token output cap — ` +
            `try lowering WORDS_PER_CHUNK in scene-split.ts, or shorten this script chunk's visual_prompt instructions.`
        );
      }
      if (!text) throw new Error(`Gemini: empty output (${JSON.stringify(json).slice(0, 300)})`);
      return text;
    }
    const errText = (await resp.text()).slice(0, 400);
    lastErr = `Gemini ${resp.status}: ${errText}`;
    if (!RETRYABLE.has(resp.status) || attempt === MAX_RETRIES) {
      throw new Error(lastErr);
    }
    // 1s, 2s, 4s, 8s
    const waitMs = 1000 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, waitMs));
    attempt++;
  }
  throw new Error(lastErr);
}

async function splitWithClaude(systemPrompt: string, script: string): Promise<string> {
  const apiKey = getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (Settings)");
  const model = getSetting("SCENE_SPLIT_MODEL") || "claude-sonnet-4-6";
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: "user", content: `Script:\n\n${script}` }],
  });
  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

/** Extracts the first JSON array from a text response, even if the model added markdown. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    throw new Error("Could not parse JSON from model response");
  }
}

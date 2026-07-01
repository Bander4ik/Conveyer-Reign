import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { getPrompt } from "../prompts";
import { log } from "../logger";
import { getRunDir } from "../run-paths";
import { normalizeScenes } from "./beats";
import { assignShotGrammar, shotTypeHistogram, SHOT_TYPES, CAMERA_MOVES, EMPHASES } from "./shot-grammar";
import { AI_ONLY_MODE } from "../ai-only";

export interface Scene {
  index: number;
  text: string;
  visual_prompt: string;
  duration_hint_sec: number;
  /** Names of the cast members visually present in this scene (for character
   *  consistency). Empty/absent when the scene has no defined characters. */
  characters?: string[];
  /** Per-scene visual routing (set by the scene-split prompt):
   *   - "generated" (default): AI image / Veo clip from visual_prompt
   *   - "real_image": fetch a real photo via real_image_query (Ken Burns, AI fallback)
   *   - "person_overlay": fetch a real person's photo via wikipedia_lookup, labelled person_name */
  visual_type?: "generated" | "real_image" | "person_overlay";
  person_name?: string;
  wikipedia_lookup?: string;
  real_image_query?: string;
  /** Visual continuity: true = this scene CUTS to a new subject/place/chapter
   *  (start of a new "shot"); false/absent = continues the same subjects+setting
   *  as the previous scene. Used to anchor a shot's look across its scenes. */
  new_shot?: boolean;
  /** Shot grammar (set by scene-split when SHOT_GRAMMAR is on, then completed by
   *  the deterministic assignShotGrammar pass). shot_type drives image framing;
   *  camera_move drives clip motion; emphasis is editorial intent. See
   *  shot-grammar.ts. All optional — absent = the old global look. */
  shot_type?:
    | "establishing"
    | "wide"
    | "medium"
    | "close"
    | "macro"
    | "aerial"
    | "insert"
    | "over_shoulder";
  camera_move?: "static" | "slow_push" | "pull_back" | "track" | "pan" | "tilt" | "drift";
  emphasis?: "normal" | "emphasis" | "climax" | "reveal";
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

For EVERY scene object you output, ALSO include a "characters" field: a JSON array of the NAMES (copied EXACTLY as written above, including capitalization) of any of these characters who are visually depicted in that scene. Use an empty array [] when none of them appear. A character "appears" when the scene's visual would actually show that specific subject (animal, creature or person). Treat the host / presenter as appearing whenever the narration is them addressing the viewer or the script focuses on them. Never put a name in "characters" that is not in the list above.`;
}

/**
 * Always appended. Lets the scene-split model route EACH scene's visual per
 * scene, so one video can freely mix AI footage, real photos and real people.
 * Works with any theme/prompt; scenes default to "generated" if not tagged.
 */
function buildRoutingSuffix(): string {
  return `

── PER-SCENE VISUAL TYPE (optional, per scene) ──
For EACH scene you MAY add a "visual_type" field choosing how its visual is sourced:
- "generated" (DEFAULT): AI-generated from "visual_prompt". Use for fictional, dramatized or generic scenes.
- "real_image": the scene shows a REAL thing best seen as an actual photograph (a specific animal species, place, or named object). ALSO set "real_image_query": a precise web/Wikipedia search string (e.g. "Bengal tiger", "Nile crocodile", "Serengeti acacia savanna"). Keep "visual_prompt" as the AI fallback.
- "person_overlay": the scene features a REAL named person (a wildlife biologist, historical figure). ALSO set "wikipedia_lookup": the exact Wikipedia article title (e.g. "David Attenborough"), and "person_name": the on-screen display name. Keep "visual_prompt" as the AI fallback.
Only use "real_image"/"person_overlay" when a real photo genuinely exists and fits; otherwise omit "visual_type" (or use "generated"). When you set "real_image" or "person_overlay", you MUST also set its query field.`;
}

/**
 * Appended when SHOT_GRAMMAR is on. Asks the model to ALSO tag each scene with a
 * documentary shot grammar — framing, camera move, and editorial emphasis — so
 * the run is edited like a film instead of a slideshow of identical shots. Added
 * as a runtime SUFFIX (not baked into the stored scene_split prompt) so it
 * reaches existing installs and disappears cleanly when the toggle is off.
 * Fields are OPTIONAL hints; assignShotGrammar fills/normalizes anything missing.
 */
function buildShotGrammarSuffix(): string {
  return `

── SHOOT LIKE A DOCUMENTARY EDITOR (shot grammar, per scene) ──
For EACH scene, ALSO think like the editor of a wildlife film and add three optional fields:
- "shot_type": the FRAMING of the shot. One of:
  • "establishing" — open a new location/chapter: subject small in a vast landscape.
  • "wide" — full body of the subject in its environment.
  • "medium" — subject from a natural distance (the default workhorse).
  • "close" — tight on the head/face, eyes; for tension and emotion.
  • "macro" — extreme detail: claws, fur, eyes, a single texture.
  • "aerial" — high looking-down drone view of the terrain.
  • "insert" — a brief cutaway to one telling detail of THIS moment.
  • "over_shoulder" — ONLY when TWO subjects confront each other: framed from behind the near animal looking toward the other (e.g. predator vs prey standoff).
- "camera_move": the MOTION. One of: "static" (hold), "slow_push" (push in), "pull_back" (reveal context), "track" (follow movement), "pan", "tilt", "drift" (aerial).
- "emphasis": editorial intent. One of: "normal", "emphasis" (an important beat), "climax" (the peak/most intense moment — usually a close hold), "reveal" (the moment something hidden or surprising is disclosed — usually a revealing move).
Rules:
- VARY the framing across consecutive scenes — do NOT shoot everything "medium". Open a shot wide/establishing, then move closer for detail and emotion.
- Use "over_shoulder" ONLY when the scene genuinely shows two subjects facing off. Use "macro"/"insert" for texture and detail beats.
- Reserve "climax" for the single most intense beat and "reveal" for genuine disclosures — not every scene.
- These are HINTS; if unsure, omit a field and the pipeline will choose. Never change "text" or "visual_prompt" to fit a shot type.`;
}

/**
 * Appended ONLY when the channel has "Connected scenes" (continuity) on. Tells
 * the model to treat the script as ONE continuous story and tag where a real
 * visual cut happens, so the image stage can keep the SAME subjects/look across
 * the scenes of a shot.
 */
function buildContinuitySuffix(): string {
  return `

── ONE CONTINUOUS STORY (visual continuity) ──
Treat the WHOLE script as ONE continuous, connected story — not a list of separate, unrelated clips. Group consecutive sentences that stay in the SAME visual scene (same subjects/animals, same place, same time of day, same lighting) into one "shot". Within a shot, each scene shows the SAME subjects from a slightly different angle or a later moment of the SAME action that the narration describes — NOT a brand-new picture.
For EACH scene add a boolean field "new_shot":
- "new_shot": true ONLY on a REAL visual change — the SUBJECT changes, the LOCATION changes, a MAJOR action changes, or a new chapter begins ("meanwhile…", "but the rival…", "next round").
- "new_shot": false (you may also omit it) when the scene continues the same subject, place and action as the previous scene.
Do NOT set new_shot:true just because: a new sentence starts, the narration adds more facts or statistics, or the description continues within the same moment.
The very first scene is always a new shot. Keep MOST consecutive scenes new_shot:false so the video reads as one unfolding event, not a montage.`;
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
const WORDS_PER_CHUNK = 2500;

/**
 * Splits the script into scenes. Supports Google Gemini (default, cheap) and
 * Anthropic Claude. Scripts longer than ~3 000 words (≈ 20–25 min of
 * narration) are automatically chunked — no manual intervention needed.
 */
/**
 * AI-only Layer 1 guarantee: strip every real-media routing field so no scene
 * can pull Wikimedia / stock / real footage — every visual stays AI-generated
 * (image-gen → img2vid). This is the single chokepoint that keeps the pipeline
 * 100% AI-only regardless of channel flags or LLM output.
 *
 * Idempotent and SOURCE-AGNOSTIC: it must run on EVERY path that produces scenes
 * — a fresh `splitScript`, AND scenes loaded from a cached `scenes.json` (e.g.
 * smart reassemble of an older run made before this enforcement existed). No-op
 * when AI_ONLY_MODE is off. Only touches real-media fields; continuity
 * (characters[], new_shot) and beat sizing are preserved. See ai-only.ts.
 */
export function sanitizeAiOnlyScenes(scenes: Scene[], runId: string): void {
  if (!AI_ONLY_MODE) return;
  let stripped = 0;
  for (const s of scenes) {
    if ((s.visual_type && s.visual_type !== "generated") || s.real_image_query || s.wikipedia_lookup) {
      stripped++;
    }
    s.visual_type = "generated";
    s.real_image_query = undefined;
    s.wikipedia_lookup = undefined;
    s.person_name = undefined;
  }
  if (stripped > 0) {
    log(
      runId,
      "info",
      `AI-only: stripped real-media routing from ${stripped} scene(s) — all visuals AI-generated`,
      { stage: "scene_split" }
    );
  }
}

export async function splitScript(
  runId: string,
  script: string,
  cast: CastMember[] = [],
  sceneSplitPrompt?: string,
  continuity = false
): Promise<Scene[]> {
  const provider = (getSetting("SCENE_SPLIT_PROVIDER") || "google").toLowerCase();
  // Layer 2 (AI-only): never show the LLM the real-media routing instruction, so
  // it won't emit visual_type:"real_image"/"person_overlay" in the first place.
  const systemPrompt =
    (sceneSplitPrompt ?? getPrompt("scene_split")) +
    buildCastSuffix(cast) +
    (AI_ONLY_MODE ? "" : buildRoutingSuffix()) +
    (continuity ? buildContinuitySuffix() : "") +
    (getSetting("SHOT_GRAMMAR") === "1" ? buildShotGrammarSuffix() : "");

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

  // Deterministic, timing-driven beat sizing (transplanted from VIP buildBeats).
  // The LLM owns scene SEMANTICS; this re-SIZES the scenes so no beat runs past
  // Veo's ~8 s of motion (no frozen tails) and runts don't slideshow — while
  // preserving the verbatim-coverage invariant and all continuity fields. Long
  // scenes become chained sub-beats (continuations new_shot:false) that the
  // existing motion-chaining stitches into one continuous shot. Toggle off with
  // BEAT_NORMALIZER=0 to A/B against the raw LLM split.
  if (getSetting("BEAT_NORMALIZER") === "1") {
    const before = allScenes.length;
    allScenes = normalizeScenes(allScenes, {
      targetSec: Number(getSetting("BEAT_TARGET_SEC") || "7"),
      minSec: Number(getSetting("BEAT_MIN_SEC") || "3.5"),
      maxSec: Number(getSetting("BEAT_MAX_SEC") || "8"),
      wordsPerSec: Number(getSetting("NARRATION_WORDS_PER_SEC") || "2.63"),
    });
    if (allScenes.length !== before) {
      log(
        runId,
        "info",
        `Beat normalizer: ${before} → ${allScenes.length} scenes (deterministic Veo-safe sizing)`,
        { stage: "scene_split" }
      );
    }
  }

  // Shot grammar — documentary shot design (framing / camera move / emphasis).
  // Runs AFTER the beat normalizer so it sees the final scene list (including
  // chained sub-beats) and completes the LLM's per-scene hints: fills gaps by
  // position-in-shot, guarantees framing variety, and derives camera moves from
  // emphasis. shot_type drives image framing (anchors/chain-heads), camera_move
  // drives every clip's motion. Toggle off with SHOT_GRAMMAR=0. See shot-grammar.ts.
  if (getSetting("SHOT_GRAMMAR") === "1") {
    assignShotGrammar(allScenes);
    log(runId, "info", `Shot grammar: ${shotTypeHistogram(allScenes)}`, { stage: "scene_split" });
    // Per-scene breakdown (debug) — lets calibration verify the LLM is choosing
    // semantically appropriate grammar per beat rather than collapsing into one
    // repeated tag. Format: "#i → shot_type / camera_move / emphasis".
    for (const s of allScenes) {
      log(
        runId,
        "debug",
        `Scene #${s.index} → ${s.shot_type ?? "—"} / ${s.camera_move ?? "—"} / ${s.emphasis ?? "normal"}`,
        { stage: "scene_split" }
      );
    }
  }

  // Layer 1 (AI-only PRIMARY GUARANTEE) — see sanitizeAiOnlyScenes. The same
  // pass MUST run on EVERY source of scenes (here, and on cached scenes.json in
  // smart reassemble), so it lives in a shared, idempotent function.
  sanitizeAiOnlyScenes(allScenes, runId);

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

/** A recurring subject + one shared style/world block, auto-extracted from the
 *  script so the pipeline can lock the look without manual cast entry. */
export interface StoryBible {
  /** One short style/environment block appended to every scene's image prompt
   *  (biome, time of day, lighting, palette, camera language). "" = none. */
  world: string;
  /** The recurring animals/characters (become an auto-cast with locked refs). */
  subjects: CastMember[];
}

const EMPTY_BIBLE: StoryBible = { world: "", subjects: [] };

/** Cap on auto-extracted subjects — enough for a predator-vs-prey matchup plus
 *  one or two supporting animals, without spending portrait credits on extras. */
const MAX_BIBLE_SUBJECTS = 4;

const STORY_BIBLE_PROMPT = `You are a continuity supervisor for an automated faceless-video pipeline.
Read the whole script and extract a compact "story bible" so every shot shares ONE consistent look.

Return a STRICTLY valid JSON object (no markdown, no prose) with exactly these fields:
{
  "world": "ONE or TWO sentences describing the SHARED setting that should stay constant across the whole video — biome / location, time of day, weather, lighting, color palette, and camera language (lens, grade). Pure style + environment, NO specific action. Example: \\"Sun-baked East African savanna at golden hour, dry grass and scattered acacia, warm low-angle light, dust in the air, shallow telephoto depth of field, natural documentary color grade.\\"",
  "subjects": [
    {
      "name": "short stable label used to tag scenes, e.g. \\"Honey badger\\" or \\"Leopard cub\\"",
      "species": "real species / what it is",
      "description": "a precise visual description to keep this subject IDENTICAL every time it appears: species, size/build, coloration and markings, distinguishing features, approximate age. No action, no background."
    }
  ]
}

Rules:
- "subjects" = only the RECURRING creatures/characters that appear in MULTIPLE scenes and must look the same each time. Skip one-off background animals. Maximum ${MAX_BIBLE_SUBJECTS}.
- Be faithful to the script: use the actual animals/people it describes. Do not invent a different genre.
- If the script has no recurring subject, return "subjects": [].
- Keep it short. Output ONLY the JSON object.`;

/**
 * Extracts a shared world/style block + the recurring subjects from the whole
 * script via ONE LLM call. Best-effort: any failure returns an empty bible so
 * the pipeline simply runs without auto-continuity (no regression). Reuses the
 * same provider plumbing as splitScript.
 */
export async function extractStoryBible(runId: string, script: string): Promise<StoryBible> {
  const provider = (getSetting("SCENE_SPLIT_PROVIDER") || "google").toLowerCase();
  try {
    let raw: string;
    if (provider === "google") {
      raw = await splitWithGemini(STORY_BIBLE_PROMPT, script);
    } else if (provider === "anthropic") {
      raw = await splitWithClaude(STORY_BIBLE_PROMPT, script);
    } else {
      return EMPTY_BIBLE;
    }

    const obj = parseBibleObject(raw);
    if (!obj) return EMPTY_BIBLE;

    const world = typeof obj.world === "string" ? obj.world.replace(/\s+/g, " ").trim() : "";
    const rawSubjects = Array.isArray(obj.subjects) ? obj.subjects : [];
    const subjects: CastMember[] = [];
    for (const s of rawSubjects) {
      if (!s || typeof s !== "object") continue;
      const o = s as Record<string, unknown>;
      const name = String(o.name ?? "").trim();
      if (!name) continue;
      const species = String(o.species ?? "").trim();
      const desc = String(o.description ?? "").trim();
      // Fold species into the description so the existing character pipeline
      // (which only knows name + description) carries the full visual lock.
      const description = [species, desc].filter(Boolean).join(" — ") || undefined;
      subjects.push({ name, description, isHost: false });
      if (subjects.length >= MAX_BIBLE_SUBJECTS) break;
    }

    log(
      runId,
      "info",
      `Story bible: ${subjects.length} recurring subject(s)${
        subjects.length ? ` (${subjects.map((s) => s.name).join(", ")})` : ""
      }${world ? " · shared world locked" : ""}`,
      { stage: "scene_split", data: { world: world.slice(0, 160), subjects: subjects.map((s) => s.name) } }
    );
    return { world, subjects };
  } catch (e) {
    log(runId, "warn", `Story-bible extraction failed (continuity auto-cast skipped): ${(e as Error).message.slice(0, 160)}`, {
      stage: "scene_split",
    });
    return EMPTY_BIBLE;
  }
}

/** Parse a single JSON object out of a model response (tolerant of fences and
 *  trailing prose). Returns null if nothing parseable. */
function parseBibleObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const j = JSON.parse(trimmed);
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const j = JSON.parse(match[0]);
        return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
      } catch {}
    }
    return null;
  }
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
    visual_type:
      s.visual_type === "real_image" || s.visual_type === "person_overlay"
        ? s.visual_type
        : "generated",
    person_name: typeof s.person_name === "string" ? s.person_name.trim() : "",
    wikipedia_lookup: typeof s.wikipedia_lookup === "string" ? s.wikipedia_lookup.trim() : "",
    real_image_query: typeof s.real_image_query === "string" ? s.real_image_query.trim() : "",
    new_shot: Boolean(s.new_shot),
    // Shot grammar hints — accepted only from the allowed vocabularies; anything
    // else (or absent) is left undefined for assignShotGrammar to fill.
    shot_type: SHOT_TYPES.has(s.shot_type) ? s.shot_type : undefined,
    camera_move: CAMERA_MOVES.has(s.camera_move) ? s.camera_move : undefined,
    emphasis: EMPHASES.has(s.emphasis) ? s.emphasis : undefined,
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

  // Retry with exponential backoff + jitter for transient failures. Two kinds
  // are retried: (a) retryable HTTP statuses (503 UNAVAILABLE / 429 RATE_LIMIT /
  // 500 / 502 / 504 — common Google API blips) and (b) network-level throws
  // (fetch failed / socket hang up / ECONNRESET / DNS / TLS) — Gemini often
  // drops the connection during an outage instead of returning a clean 503 body,
  // and those used to escape un-retried. Deterministic failures (output-cap
  // finishReason, empty output, non-retryable status) are NOT retried.
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const MAX_RETRIES = 4; // 5 attempts total (≥ the requested 3)

  // A transient failure worth retrying. Anything else thrown is fatal.
  class TransientError extends Error {}

  const attemptOnce = async (): Promise<string> => {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch((e) => {
      // Network-level failure — no HTTP response at all. Transient: retry.
      throw new TransientError(`Gemini network error: ${(e as Error).message}`);
    });

    if (!resp.ok) {
      const errText = (await resp.text().catch(() => "")).slice(0, 400);
      const msg = `Gemini ${resp.status}: ${errText}`;
      if (RETRYABLE.has(resp.status)) throw new TransientError(msg);
      throw new Error(msg); // non-retryable status (e.g. 400/401/403) — fail fast
    }

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
  };

  let lastErr = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await attemptOnce();
    } catch (e) {
      // Only transient failures are retried; fatal errors propagate immediately.
      if (!(e instanceof TransientError) || attempt === MAX_RETRIES) throw e;
      lastErr = e.message;
      // Exponential base (1s, 2s, 4s, 8s) with equal jitter → a random delay in
      // [base/2, base]. The jitter de-syncs parallel chunk + story-bible calls so
      // they don't all retry on the same tick and re-hammer Gemini together.
      const base = 1000 * Math.pow(2, attempt);
      const waitMs = base / 2 + Math.random() * (base / 2);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw new Error(lastErr || "Gemini: request failed after retries");
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

/**
 * Salvage every top-level {…} object out of an array's text, parsing each on its
 * own. A single malformed scene (stray control char, bad escape, truncated tail)
 * then drops just that one scene instead of failing the whole run. String-aware
 * brace matching so braces inside text/visual_prompt don't confuse it.
 */
function salvageObjects(text: string): unknown[] {
  const objs: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            objs.push(JSON.parse(text.slice(start, i + 1)));
          } catch {
            // skip this malformed object, keep going
          }
          start = -1;
        }
      }
    }
  }
  return objs;
}

/** Extracts the JSON array from a model response, tolerant of markdown fences,
 *  trailing prose, and a single malformed/truncated scene. */
function extractJson(text: string): unknown {
  // Strip ```json … ``` fences if present.
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    // Per-object salvage — recover the scenes that DID parse rather than crash.
    const salvaged = salvageObjects(match ? match[0] : trimmed);
    if (salvaged.length > 0) return salvaged;
    throw new Error("Could not parse JSON from model response");
  }
}

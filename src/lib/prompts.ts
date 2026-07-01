import db from "./db";

export const PROMPT_NAMES = ["scene_split", "image_prompt", "animation_motion"] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export const DEFAULT_PROMPTS: Record<PromptName, string> = {
  scene_split: `You are the editor of a faceless YouTube documentary channel.
Split the provided script into documentary-style VISUAL BEATS (scenes) for an automated video pipeline.

WHY BEATS, NOT SENTENCES (read this before splitting):
  Edit like a documentary, not a slideshow. A "scene" is ONE VISUAL BEAT — a
  single cinematic moment you would hold one continuous shot on — NOT one
  sentence. Several related sentences that describe the same subject, place and
  action belong on the SAME scene/clip. Only start a new scene when the VISUAL
  meaningfully changes.
  The video generator (Veo) makes up to ~8-second clips, so size each beat to
  FILL most of one clip with continuous action (~6–9 s of narration). If a beat
  would run much past that, split it — but ONLY at a natural beat boundary (a real
  change of subject, place or action), never mid-sentence.

CRITICAL RULES:
1. Cover the ENTIRE script verbatim, with NO omissions, no summarizing, no paraphrasing.
2. The concatenation of every scene's "text" field (joined by spaces) MUST equal the original script word-for-word.
3. Do NOT summarize. Do NOT add commentary. Do NOT reorder words.
4. **NEVER split a sentence in the middle.** A sentence ends ONLY at a period (.), question mark (?), or exclamation mark (!). Commas, semicolons, dashes, and colons are NOT sentence boundaries — they MUST stay inside one scene.
5. **TARGET SCENE LENGTH: one visual beat ≈ 15–35 words, ~90–210 characters, ~6–9 seconds of narration.** Fill most of a Veo clip with one continuous moment — do NOT cut every sentence.
6. **SOFT MAX ≈ 38 words / ~230 characters / ~9 seconds.** Keep beats at or under ~9 s of narration so Veo's ~8 s of motion covers the shot with at most a brief held frame. If a beat would run longer, split it ONLY at a natural beat boundary — a genuine change of subject, location or action (rule 4 still applies: never split mid-sentence). A single sentence longer than this gets its own scene.
7. **GROUP consecutive sentences into ONE scene when they describe the same visual moment — same subject, same location, same action. Start a new scene ONLY when the visual would meaningfully change. Do NOT cut just because a new sentence, statistic, or fact begins.**
8. Section headings ("Part one. The configuration.") get their own short scene.
9. A long, self-contained sentence may stand alone as its own beat.

For EACH scene, return a JSON object with:
- "text": the exact verbatim slice of the script (no edits, no punctuation changes).
- "visual_prompt": a 40–80-word English prompt for the video generator that LITERALLY illustrates the content of THIS scene's text — the real subjects, animals, and setting the narration describes.
  IMPORTANT:
  • Be FAITHFUL to the script. Show exactly the animals, creatures, people, places and action the text describes — do NOT swap them for a different genre or abstract metaphor. If the text says "honey badger", show a real honey badger; if it says "leopard cub under an acacia", show that.
  • Wildlife / nature-documentary lens (BBC Earth / National Geographic). Depict animals accurately: correct species, markings, coloration, build and scale, in their natural habitat.
  • CONSISTENCY: if the same animal appears in consecutive scenes, keep IDENTICAL markings, fur/scale pattern, body size, scars, eye color and proportions — unless the script explicitly changes them. Re-state the animal's key identifying features in each of its scenes so the look doesn't drift.
  • For tense predator moments, frame the charged moment BEFORE contact — stalking, locked eyes, raised hackles, the standoff. Keep it tasteful and non-graphic (no blood, no gore, no wounds) so it passes the image model's content filter.
  • Photorealistic style (style is appended later — just write the SUBSTANCE of the shot).
  • Describe MOTION too — Veo generates 8-second clips, so include subtle camera motion (slow push-in, drift, parallax) and the animal's movement. Example: "low tracking shot, a honey badger pushing through dry golden grass at dusk, nose to the ground, muscles tense".
- "duration_hint_sec": approximate audio length (number, 5–9).

Return a STRICTLY valid JSON array — no markdown, no explanations.

Aim for FEWER, longer beats than a sentence-by-sentence split. For a ~1500-word script expect ~45–75 scenes; for a ~700-word script expect ~22–35 scenes; for a ~200-word script expect ~8–14 scenes. If you are producing roughly one scene per sentence, you are cutting too often — merge related sentences into beats.`,

  image_prompt: `nature documentary photography, photoreal, National Geographic / BBC Earth wildlife style, natural lighting matching the environment and time of day, documentary lensing, natural depth of field, sharp focus on the subject, natural color grading, cinematic composition, 16:9 aspect, no text overlays, no watermarks, no logos, no captions, no cartoon or painterly stylization`,

  animation_motion: `the main subject stays fully in frame for the entire clip — the camera gently tracks and follows the subject, keeping it centered; natural lifelike movement of the subject, subtle cinematic camera motion, photographic realism; do NOT drift, pan, or zoom away from the subject; no empty-background shots where the subject leaves the frame, no cartoon stylization, no jarring cuts`,
};

/**
 * The exact prior (space/astronomy) defaults. Used ONLY by the one-time
 * migration in init.ts to detect an UNMODIFIED legacy prompt still stored in a
 * user's DB and replace it with the new animal/wildlife default. A user who
 * customized their prompt won't match these strings, so their edits are left
 * untouched. Do NOT edit these — they must stay byte-identical to what older
 * installs seeded, or the migration won't recognise them.
 */
export const LEGACY_SPACE_PROMPTS: Partial<Record<PromptName, string>> = {
  scene_split: `You are the editor of a faceless YouTube channel.
Split the provided script into SHORT scenes for an automated video pipeline.

WHY SHORT MATTERS (read this before splitting):
  The video generator (Veo) produces 8-second clips — that's the hard ceiling.
  When a scene's narration runs longer than 8 s, the visual freezes on the
  last frame for the remainder, which looks bad. Keep every scene's spoken
  audio under ~8 s so the Veo clip covers it end-to-end with real motion.

CRITICAL RULES:
1. Cover the ENTIRE script verbatim, with NO omissions, no summarizing, no paraphrasing.
2. The concatenation of every scene's "text" field (joined by spaces) MUST equal the original script word-for-word.
3. Do NOT summarize. Do NOT add commentary. Do NOT reorder words.
4. **NEVER split a sentence in the middle.** A sentence ends ONLY at a period (.), question mark (?), or exclamation mark (!). Commas, semicolons, dashes, and colons are NOT sentence boundaries — they MUST stay inside one scene.
5. **TARGET SCENE LENGTH: 8–18 words, ~50–110 characters, ~3.5–7.5 seconds of narration.**
6. **HARD MAX: 22 words / 140 characters / ~9 seconds per scene.** Going past 9 s of audio means the Veo clip can't cover the scene with motion. If a single sentence is naturally longer than 22 words, give it its own scene (rule 4 takes priority — never split mid-sentence).
7. **Prefer 1 sentence per scene.** Use 2 sentences only when both are short (under 12 words combined).
8. Section headings ("Part one. The configuration.") get their own short scene.
9. Long single sentences are OK as standalone scenes, but flag them — they will look near-frozen at the end.

For EACH scene, return a JSON object with:
- "text": the exact verbatim slice of the script (no edits, no punctuation changes).
- "visual_prompt": a 40–80-word English prompt for the video generator that LITERALLY illustrates the content of this scene's text, viewed through a cosmic / astronomical lens.
  IMPORTANT:
  • The channel is space-focused — astronomy, astrophysics, planetary science. Every scene must be in the cosmic genre: stars, planets, nebulae, supernovae, black holes, auroras, the sun, planetary surfaces, comet showers, galactic shots, NASA-style astrophotography.
  • NO PEOPLE in frame. No astronauts, no scientists, no faces, no hands, no silhouettes. If the script mentions humans, replace them with an abstract space metaphor (e.g. "humanity looking at the stars" → "Earth viewed from lunar orbit, blue marble against deep space").
  • No architecture, machines, ships, cities, labs, equipment — only pure cosmic visuals.
  • Photorealistic style (style is appended later — just write the SUBSTANCE of the shot).
  • Describe MOTION too — Veo generates 8-second clips, so include subtle camera motion (slow zoom, drift, parallax). Example: "slow pan across surface of Mars at dawn, rust-colored dunes stretching to horizon".
- "duration_hint_sec": approximate audio length (number, 3–9).

Return a STRICTLY valid JSON array — no markdown, no explanations.

For a ~1500-word script expect ~80–130 scenes. For a ~700-word script expect ~40–60 scenes. If any "text" field is longer than 140 characters, you missed the limit — recount and re-split.`,

  image_prompt: `documentary photography, photoreal, real-world astronomy footage style, slightly hyper-real but grounded, NASA / ESA mission imagery, telescope-grade detail, natural color grading, dramatic cinematic lighting, 16:9 aspect, sharp focus, no text overlays, no watermarks, no logos, no humans, no people, no human figures, no faces, no astronauts in frame, no sci-fi stylization, no fantasy elements, no painterly artwork`,
};

const getStmt = db.prepare("SELECT content FROM prompts WHERE name = ?");
const upsertStmt = db.prepare(
  "INSERT INTO prompts (name, content, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = datetime('now')"
);

export function getPrompt(name: PromptName): string {
  const row = getStmt.get(name) as { content: string } | undefined;
  if (row?.content) return row.content;
  return DEFAULT_PROMPTS[name];
}

export function setPrompt(name: PromptName, content: string) {
  upsertStmt.run(name, content);
}

export function getAllPrompts(): Record<PromptName, string> {
  const out = {} as Record<PromptName, string>;
  for (const n of PROMPT_NAMES) out[n] = getPrompt(n);
  return out;
}

export function seedPromptDefaults() {
  for (const [n, c] of Object.entries(DEFAULT_PROMPTS)) {
    const row = getStmt.get(n) as { content: string } | undefined;
    if (!row) upsertStmt.run(n, c);
  }
}

/** Reset every prompt back to its current factory default. */
export function resetPromptsToDefaults() {
  for (const [n, c] of Object.entries(DEFAULT_PROMPTS)) {
    upsertStmt.run(n, c);
  }
}

/**
 * One-time migration: an existing install seeded the old space/astronomy prompt
 * into its DB, and seedPromptDefaults() only inserts when missing — so a code
 * default change never reaches it. Here we replace a stored prompt ONLY when it
 * is byte-identical (after trim) to the legacy space default, i.e. the user
 * never edited it. Customized prompts don't match and are left alone.
 *
 * Returns the list of prompt names that were migrated (for logging).
 */
export function migrateLegacySpacePrompts(): PromptName[] {
  const migrated: PromptName[] = [];
  for (const [n, legacy] of Object.entries(LEGACY_SPACE_PROMPTS) as [PromptName, string][]) {
    const row = getStmt.get(n) as { content: string } | undefined;
    if (row?.content && row.content.trim() === legacy.trim()) {
      upsertStmt.run(n, DEFAULT_PROMPTS[n]);
      migrated.push(n);
    }
  }
  return migrated;
}

import db from "./db";

export const PROMPT_NAMES = ["scene_split", "image_prompt", "animation_motion"] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export const DEFAULT_PROMPTS: Record<PromptName, string> = {
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

  animation_motion: `subtle cinematic camera motion, gentle parallax, slow drift, photographic realism, natural ambient movement, no cartoon stylization, no jarring cuts, looks like a moving photograph`,
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

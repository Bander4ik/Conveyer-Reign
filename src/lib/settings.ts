import db from "./db";

/**
 * Keys the user can edit through the UI or via .env.
 * UI takes precedence over .env (env is only the fallback when the DB row is empty).
 */
export const SETTING_KEYS = [
  // ── Required API keys ─────────────────────────────────────────────
  "GOOGLE_API_KEY",          // Gemini — scene splitting
  "LABS69_API_KEY",          // 69labs — TTS + images + img2vid (all-in-one)
  "KIE_API_KEY",             // kie.ai — alternative all-in-one backend (images + Veo video + ElevenLabs TTS)

  // ── Optional / backup providers ───────────────────────────────────
  "ELEVENLABS_API_KEY",      // direct ElevenLabs (without 69labs)
  "REPLICATE_API_TOKEN",     // Replicate (Flux / Kling)
  "ANTHROPIC_API_KEY",       // Claude (alternative to Gemini)
  "OPENAI_API_KEY",          // OpenAI TTS / image backup
  "FAL_API_KEY",             // fal.ai (alternative to Replicate)
  "GROQ_API_KEY",            // Groq Whisper — word timestamps for single-shot voiceover alignment
  "PEXELS_API_KEY",          // Pexels — real stock footage (video + photo). One key per line for multiple.
  "FFMPEG_PATH",             // absolute path to ffmpeg.exe if not in system PATH

  // ── Storage ───────────────────────────────────────────────────────
  "RUNS_OUTPUT_DIR",         // where run folders are written. Empty = default

  // ── Scene splitting (LLM) ─────────────────────────────────────────
  "SCENE_SPLIT_PROVIDER",    // google | anthropic
  "SCENE_SPLIT_MODEL",       // e.g. gemini-flash-latest, claude-sonnet-4-6

  // ── Beat normalizer (deterministic Veo-safe scene sizing) ─────────
  "BEAT_NORMALIZER",         // "1" on (default) | "0" off — re-size LLM scenes deterministically so no beat exceeds Veo's motion ceiling
  "BEAT_TARGET_SEC",         // target beat length in seconds (~fills one Veo clip)
  "BEAT_MIN_SEC",            // runts shorter than this fold into the previous same-shot beat
  "BEAT_MAX_SEC",            // hard cap — scenes longer than this are subdivided into chained sub-beats
  "NARRATION_WORDS_PER_SEC", // measured narration rate used to estimate beat seconds (≈ 2.63)

  // ── Shot grammar (documentary shot design) ────────────────────────
  "SHOT_GRAMMAR",            // "1" on (default) | "0" off — per-scene shot_type/camera_move/emphasis vs the old single global look

  // ── Text-to-Speech ────────────────────────────────────────────────
  "TTS_MODE",                // per-scene (default) | single-shot (one continuous voiceover + Whisper word-alignment; needs GROQ_API_KEY)
  "TTS_PROVIDER",            // 69labs | kie | elevenlabs | openai
  "TTS_VOICE_PROVIDER",      // For 69labs: edgetts | elevenlabs | voice-clone
  "TTS_VOICE_ID",            // Voice id (ElevenLabs / Edge / clone UUID)
  "TTS_MODEL",               // e.g. eleven_multilingual_v2
  "TTS_SPLIT_TYPE",          // smart | paragraphs | max_length

  // ── ElevenLabs voice fine-tuning ──────────────────────────────────
  "TTS_SPEED",               // 0.7–1.2 (lower = slower)
  "TTS_STABILITY",           // 0–1
  "TTS_SIMILARITY_BOOST",    // 0–1
  "TTS_STYLE",               // 0–1
  "TTS_USE_SPEAKER_BOOST",   // "1" / "0" / ""

  // ── Auto-pause (stops TTS from "swallowing" sentence ends) ────────
  "TTS_AUTO_PAUSE",          // "1" to enable
  "TTS_PAUSE_DURATION",      // seconds (0.1–30)
  "TTS_PAUSE_FREQUENCY",     // 1–100

  // ── Images ────────────────────────────────────────────────────────
  "IMAGE_PROVIDER",          // 69labs | kie | replicate | openai | fal
  "IMAGE_MODEL",             // e.g. nano-banana-pro, imagen-4, seedream-4.5
  "IMAGE_RATIO",             // e.g. 16:9, 9:16, 1:1
  "IMAGE_RESOLUTION",        // 1k | 2k | 4k (for models that support it)

  // ── Vision QC gate (verify the generated frame: subject correctness + cinema) ──
  "IMAGE_QC",                // "1" on (default) | "0" off — Gemini-vision two-axis check + regen on a hard subject miss
  "IMAGE_QC_SUBJECT_FLOOR",  // 0-100 HARD floor on subjectScore (default 55); below = always regenerate (wrong species)
  "IMAGE_QC_CINEMA",         // "log" (default, observe cinemaScore only) | "weighted" (enforce finalScore gate)
  "IMAGE_QC_THRESHOLD",      // 0-100 accept bar on finalScore — only gates in CINEMA=weighted mode (default 60)
  "IMAGE_QC_W_SUBJECT",      // weight of subjectScore in finalScore (default 0.65)
  "IMAGE_QC_W_CINEMA",       // weight of cinemaScore in finalScore (default 0.35)
  "IMAGE_QC_MAX_REGEN",      // max regenerations per image on QC failure (default 1)

  // ── Real footage (multi-source + Gemini Vision relevance scoring) ──
  "STOCK_FOOTAGE_ORIENTATION",  // landscape | portrait | square
  "STOCK_FOOTAGE_MAX_HEIGHT",   // max px height to download (e.g. 1080)
  "STOCK_FOOTAGE_MIN_DURATION", // min stock clip length in seconds
  "FOOTAGE_SOURCES",            // CSV: pexels,openverse,wikimedia,archive,pixabay
  "REAL_MATCH_THRESHOLD",       // 0-100 — Gemini Vision relevance bar (default 85)
  "VISION_MATCH_MODEL",         // Gemini model for relevance scoring (blank = scene-split model)
  "OPENVERSE_TOKEN",            // optional — higher Openverse rate limits (keyless works)
  "PIXABAY_API_KEY",            // optional — enables the Pixabay source

  // ── Thumbnails ────────────────────────────────────────────────────
  "THUMBNAIL_COUNT",            // how many thumbnail options to generate per run (3-5)

  // ── Animations (img2vid) ──────────────────────────────────────────
  "ANIMATION_PROVIDER",      // off | 69labs | kie | replicate | fal
  "ANIMATION_MODEL",         // e.g. veo-video, grok-imagine-video
  "ANIMATION_RATIO_PERCENT", // 0–100, percentage of scenes to animate
  "ANIMATION_DISTRIBUTION",  // first-half | alternating | random | all
  "ANIMATION_DURATION",      // seconds (provider-dependent)
  "ANIMATION_KEEP_VEO_AUDIO", // "1" to keep Veo's generated ambient audio
  "VEO_DUCK_PERCENT",        // 0–100: Veo's own ambient sound mixed UNDER the TTS voiceover (0 = off, TTS only)

  // ── Video assembly (FFmpeg) ───────────────────────────────────────
  "VIDEO_RESOLUTION",        // e.g. 1920x1080
  "VIDEO_FPS",               // 24 / 30 / 60
  "SCENE_DURATION_SECONDS",  // fallback duration when TTS length is unknown
  "TRANSITION_DURATION",     // crossfade between scenes in seconds (0 = none)
  "SCENE_TAIL_SILENCE",      // silence appended to each clip's audio (seconds), creates breathing room between scenes
  "MIN_ANIMATED_CLIP_SECONDS", // minimum on-screen length for an img2vid (Veo) clip — keeps short narration from trimming the motion to 1-2s

  // ── Performance / Concurrency ─────────────────────────────────────
  "IMAGE_CONCURRENCY",       // parallel image jobs
  "TTS_CONCURRENCY",         // parallel TTS jobs
  "ANIMATION_CONCURRENCY",   // parallel img2vid jobs
  "ASSEMBLE_CONCURRENCY",    // parallel FFmpeg clip renders
  "ASSEMBLE_XFADE_CHUNKS",            // 1 = monolithic xfade (legacy); anything else = hierarchical
  "ASSEMBLE_XFADE_MAX_CLIPS_PER_PASS", // hard cap on inputs per ffmpeg xfade call (default 50)
  "ASSEMBLE_FFMPEG_STALL_MS",         // kill an ffmpeg render that makes NO progress for this long (anti-hang; default 120000)
  "FFPROBE_TIMEOUT_MS",               // fall back to a size estimate if ffprobe doesn't answer in this long (anti-hang; default 30000)

  // ── Google Drive sync ─────────────────────────────────────────────
  // OAuth2 credentials from Google Cloud Console (Web Application client).
  // Redirect URI must be set to http://localhost:3000/api/gdrive/oauth/callback
  "GDRIVE_CLIENT_ID",
  "GDRIVE_CLIENT_SECRET",
  // Refresh token, set automatically after the user completes the OAuth flow.
  // Don't edit by hand.
  "GDRIVE_REFRESH_TOKEN",
  // Email of the Google account that authorized — set automatically, shown in UI.
  "GDRIVE_CONNECTED_EMAIL",
  // Folder IDs in Drive. Empty = auto-create `Conveyer/Final Videos` and
  // `Conveyer/Clips Library` in the user's Drive root on first sync.
  "GDRIVE_FINAL_VIDEOS_FOLDER_ID",
  "GDRIVE_CLIPS_LIBRARY_FOLDER_ID",
  // Master switch. Empty/"0" = disabled (don't upload). "1" = upload after every run.
  "GDRIVE_SYNC_ENABLED",
  // Internal one-time-migration flag (not user-facing): "1" once the legacy
  // space prompts have been migrated to the wildlife defaults. See init.ts.
  "PROMPTS_ANIMAL_MIGRATION_DONE",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const getStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertStmt = db.prepare(
  "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
);

export function getSetting(key: SettingKey): string {
  const row = getStmt.get(key) as { value: string } | undefined;
  if (row && row.value !== "") return row.value;
  return process.env[key] ?? "";
}

export function setSetting(key: SettingKey, value: string) {
  upsertStmt.run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SETTING_KEYS) out[k] = getSetting(k);
  return out;
}

/**
 * A Gemini model id safe to send to Google's generateContent endpoint. Several
 * features call Gemini DIRECTLY (battle stat card, library AI-match, footage
 * relevance scoring), so they must never receive a non-Gemini SCENE_SPLIT_MODEL
 * — e.g. a Claude id when SCENE_SPLIT_PROVIDER=anthropic — which would 404.
 * Claude is a text/vision model, not an image/video generator, so it only ever
 * drives the LLM tasks (scene split); these Gemini-only calls fall back to Flash.
 */
export function geminiModel(): string {
  const provider = (getSetting("SCENE_SPLIT_PROVIDER") || "google").toLowerCase();
  const m = getSetting("SCENE_SPLIT_MODEL") || "";
  if (provider === "anthropic" || /^claude/i.test(m)) return "gemini-flash-latest";
  return m || "gemini-flash-latest";
}

/** Keys whose values are secrets and should be masked when sent to the UI. */
function isSecretKey(key: string): boolean {
  return key.includes("KEY") || key.includes("TOKEN") || key.includes("SECRET");
}

/** Safe version — masks secret keys/tokens/secrets. Handles multi-line key lists too. */
export function getMaskedSettings(): Record<string, string> {
  const all = getAllSettings();
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (isSecretKey(k)) {
      if (!v) {
        masked[k] = "";
      } else {
        // Mask each line/entry separately so multi-key fields show all entries
        const parts = v.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean);
        masked[k] = parts.map((p) => `${p.slice(0, 4)}…${p.slice(-4)}`).join("\n");
      }
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

export const DEFAULTS: Record<SettingKey, string> = {
  // Required API keys — empty by default, user must provide
  GOOGLE_API_KEY: "",
  LABS69_API_KEY: "",
  KIE_API_KEY: "",

  // Optional providers
  ELEVENLABS_API_KEY: "",
  REPLICATE_API_TOKEN: "",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  FAL_API_KEY: "",
  GROQ_API_KEY: "",
  PEXELS_API_KEY: "",
  FFMPEG_PATH: "",

  // Storage — empty = use default (DATA_DIR/runs)
  RUNS_OUTPUT_DIR: "",

  // Scene split
  SCENE_SPLIT_PROVIDER: "google",
  SCENE_SPLIT_MODEL: "gemini-flash-latest",

  // Beat normalizer — deterministic, timing-driven sizing on top of the LLM
  // split so no beat runs past Veo's ~8 s of motion (no frozen tails) and runts
  // don't slideshow. Estimate-driven (NARRATION_WORDS_PER_SEC); long scenes
  // become chained sub-beats stitched by motion-chaining. Set "0" to disable.
  BEAT_NORMALIZER: "1",
  BEAT_TARGET_SEC: "7",
  BEAT_MIN_SEC: "3.5",
  BEAT_MAX_SEC: "8",
  NARRATION_WORDS_PER_SEC: "2.63",

  // Shot grammar — per-scene framing (shot_type), motion (camera_move) and
  // editorial intent (emphasis), tagged by the LLM in scene-split and completed
  // by a deterministic variety pass. Replaces the single global image/motion
  // strings that made every clip look the same. Set "0" to A/B the old look.
  SHOT_GRAMMAR: "1",

  // TTS — runs through 69labs; ElevenLabs is the high-quality voice family and
  // the intended default (the voice fine-tuning below is all ElevenLabs-specific).
  // Edge TTS (free Microsoft voices) and voice-clone are the alternatives,
  // switchable via TTS_VOICE_PROVIDER.
  TTS_PROVIDER: "69labs",
  // per-scene = one TTS call per scene (default). single-shot = one continuous
  // voiceover for the whole script + Groq Whisper word-alignment to scene
  // boundaries — fluid narration, no per-scene "breaths". Needs GROQ_API_KEY.
  TTS_MODE: "per-scene",
  TTS_VOICE_PROVIDER: "elevenlabs",
  TTS_VOICE_ID: "G17SuINrv2H9FC6nvetn", // ElevenLabs "Christopher" — warm documentary male
  TTS_MODEL: "eleven_multilingual_v2",
  TTS_SPLIT_TYPE: "smart",

  // Voice fine-tuning (slightly slower + small style for documentary feel)
  TTS_SPEED: "0.93",
  TTS_STABILITY: "0.6",
  TTS_SIMILARITY_BOOST: "0.75",
  TTS_STYLE: "0.15",
  TTS_USE_SPEAKER_BOOST: "1",

  // Auto-pause on sentence boundaries
  TTS_AUTO_PAUSE: "1",
  TTS_PAUSE_DURATION: "0.4",
  TTS_PAUSE_FREQUENCY: "1",

  // Images
  IMAGE_PROVIDER: "69labs",
  IMAGE_MODEL: "nano-banana-pro",
  IMAGE_RATIO: "16:9",
  IMAGE_RESOLUTION: "1k",

  // Vision QC gate — verify each AI frame shows the intended subject (catch
  // "leopard cub → bear"), regenerate once on a hard miss, keep the best frame.
  // Cheap flash vision call; real cost is the (budgeted) regenerations.
  IMAGE_QC: "1",
  // Subject correctness is a HARD floor (wrong species can never pass). 55 starts
  // slightly inside the lenient-scorer gray zone to catch borderline-wrong frames
  // without over-regenerating during calibration; recalibrate from logged scores.
  IMAGE_QC_SUBJECT_FLOOR: "55",
  // "log" = observe cinemaScore only (collect distributions, gate on subject floor
  // alone); flip to "weighted" later to enforce finalScore.
  IMAGE_QC_CINEMA: "log",
  // finalScore accept bar — only active in weighted mode.
  IMAGE_QC_THRESHOLD: "60",
  // finalScore = W_SUBJECT*subjectScore + W_CINEMA*cinemaScore.
  IMAGE_QC_W_SUBJECT: "0.65",
  IMAGE_QC_W_CINEMA: "0.35",
  IMAGE_QC_MAX_REGEN: "1",

  // Real footage (multi-source + Gemini Vision relevance scoring)
  STOCK_FOOTAGE_ORIENTATION: "landscape",
  STOCK_FOOTAGE_MAX_HEIGHT: "1080",
  STOCK_FOOTAGE_MIN_DURATION: "4",
  FOOTAGE_SOURCES: "pexels,openverse,wikimedia,archive",
  REAL_MATCH_THRESHOLD: "85",
  VISION_MATCH_MODEL: "",
  OPENVERSE_TOKEN: "",
  PIXABAY_API_KEY: "",

  // Thumbnails
  THUMBNAIL_COUNT: "4",

  // Animations
  ANIMATION_PROVIDER: "69labs",
  ANIMATION_MODEL: "veo-video",
  ANIMATION_RATIO_PERCENT: "50",
  ANIMATION_DISTRIBUTION: "first-half",
  ANIMATION_DURATION: "5",
  ANIMATION_KEEP_VEO_AUDIO: "",
  // When voiceover is ON, mix Veo's own ambient audio UNDER the narration at
  // this volume %. 30 = ambient at 30% beneath full-volume TTS. 0 = TTS only
  // (old behavior). Reign's request: keep the TTS and the Veo sound together.
  VEO_DUCK_PERCENT: "30",

  // Video assembly
  VIDEO_RESOLUTION: "1920x1080",
  VIDEO_FPS: "30",
  SCENE_DURATION_SECONDS: "5",
  TRANSITION_DURATION: "0.5",
  SCENE_TAIL_SILENCE: "0.4",
  MIN_ANIMATED_CLIP_SECONDS: "4.5",

  // Performance
  IMAGE_CONCURRENCY: "5",
  TTS_CONCURRENCY: "3",
  ANIMATION_CONCURRENCY: "3",
  ASSEMBLE_CONCURRENCY: "4",
  ASSEMBLE_XFADE_CHUNKS: "4",
  ASSEMBLE_XFADE_MAX_CLIPS_PER_PASS: "50",
  // Anti-hang: ffmpeg/ffprobe calls used to have NO timeout, so a single blocked
  // child (malformed clip, pipe stall, lost completion event) hung the whole
  // assembly forever. A render that emits no progress for STALL_MS is killed and
  // the clip is skipped; an ffprobe that doesn't answer in FFPROBE_TIMEOUT_MS
  // falls back to a size-based estimate.
  ASSEMBLE_FFMPEG_STALL_MS: "120000",
  FFPROBE_TIMEOUT_MS: "30000",

  // Google Drive — all empty by default. User fills client_id/secret;
  // OAuth flow fills refresh_token + email; folders auto-create on first sync.
  GDRIVE_CLIENT_ID: "",
  GDRIVE_CLIENT_SECRET: "",
  GDRIVE_REFRESH_TOKEN: "",
  GDRIVE_CONNECTED_EMAIL: "",
  GDRIVE_FINAL_VIDEOS_FOLDER_ID: "",
  GDRIVE_CLIPS_LIBRARY_FOLDER_ID: "",
  GDRIVE_SYNC_ENABLED: "",
  // Internal one-time-migration flag — empty until the legacy-space-prompt
  // migration has run (see init.ts). Not surfaced in the UI.
  PROMPTS_ANIMAL_MIGRATION_DONE: "",
};

/** Write defaults for any keys that aren't already in the DB. */
export function seedDefaults() {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const row = getStmt.get(k) as { value: string } | undefined;
    if (!row) upsertStmt.run(k, v);
  }
}

"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { GroupCard, dropMaskedSecrets, type Group } from "../_GroupCard";

/**
 * Advanced settings — everything that isn't a required API key or Google
 * Drive sync config. Lives at /settings/advanced so the main /settings
 * page stays short and friendly (just keys + Drive).
 *
 * This page reads + writes the SAME /api/settings endpoint as /settings.
 * Fields shown here are disjoint from /settings to avoid double-save races.
 */

const GROUPS: Group[] = [
  {
    title: "Storage Location",
    subtitle: "Where the generated audio, images, and final videos are saved on disk.",
    fields: [
      {
        key: "RUNS_OUTPUT_DIR",
        desc: "Absolute folder path for run outputs. Leave empty to use the default location inside your user profile. The settings database itself stays in the default location regardless of this setting.",
        examples: "Mac: /Users/you/Documents/Conveyer-Runs  ·  Windows: D:\\YouTube\\Conveyer-Runs",
      },
      {
        key: "FFMPEG_PATH",
        desc: "Absolute path to the FFmpeg binary. Only needed if FFmpeg is not in your system PATH. The platform requires FFmpeg for video assembly.",
        examples: "Mac: /opt/homebrew/bin/ffmpeg (Apple Silicon) or /usr/local/bin/ffmpeg (Intel)  ·  Windows: C:\\ffmpeg\\bin\\ffmpeg.exe  ·  Leave empty if `ffmpeg` works in your terminal",
      },
    ],
  },
  {
    title: "Script Breakdown (LLM)",
    subtitle: "How your script gets divided into scenes, and which language model does the splitting.",
    fields: [
      {
        key: "SCENE_SPLIT_PROVIDER",
        desc: "Which LLM service splits your script into scenes. Gemini is cheap and fast. Claude is more thorough but costs more.",
        examples: "google  or  anthropic",
      },
      {
        key: "SCENE_SPLIT_MODEL",
        desc: "Specific model id. For Google, the `-latest` alias auto-tracks the current stable Flash. For Anthropic use the full model id.",
        examples: "gemini-flash-latest, gemini-2.5-flash, gemini-2.5-pro, claude-sonnet-4-6",
      },
    ],
  },
  {
    title: "Voice Over (TTS)",
    subtitle: "Picks the narrator voice and which TTS service generates the audio.",
    fields: [
      {
        key: "TTS_PROVIDER",
        desc: "Top-level routing of TTS jobs. `69labs` is the default and covers all sub-providers below. Direct `elevenlabs` skips 69labs and uses ElevenLabs API key. `openai` uses gpt-4o-mini-tts.",
        examples: "69labs  /  elevenlabs  /  openai",
      },
      {
        key: "TTS_VOICE_PROVIDER",
        desc: "Inside 69labs, picks which voice family to use. ElevenLabs gives best quality. Edge TTS is free (Microsoft voices). Voice-clone uses celebrity clones (Lex Fridman, Joe Rogan, etc).",
        examples: "elevenlabs  /  edgetts  /  voice-clone",
      },
      {
        key: "TTS_VOICE_ID",
        desc: "The specific voice. Format depends on the voice-provider above. For ElevenLabs: voice ID from their library. For Edge: locale + voice name. For voice-clone: UUID from 69labs library.",
        examples: "ElevenLabs Christopher: G17SuINrv2H9FC6nvetn — Edge: en-US-GuyNeural, en-GB-RyanNeural, en-US-AriaNeural",
      },
      {
        key: "TTS_MODEL",
        desc: "Optional model override. For ElevenLabs `eleven_multilingual_v2` is the high-quality default. `eleven_flash_v2_5` is faster but slightly less expressive. Leave empty to use provider default.",
        examples: "eleven_multilingual_v2, eleven_flash_v2_5, gpt-4o-mini-tts",
      },
      {
        key: "TTS_SPLIT_TYPE",
        desc: "How the TTS service chunks your text internally. `smart` splits at sentence boundaries (best for narration). `paragraphs` only at paragraph breaks. `max_length` uses fixed sizes.",
        examples: "smart  /  paragraphs  /  max_length",
      },
    ],
  },
  {
    title: "Voice Fine-Tuning (ElevenLabs voices)",
    subtitle: "Subtle voice character controls. Active when TTS_VOICE_PROVIDER = elevenlabs — works whether you reach ElevenLabs directly or through 69labs's gateway. Ignored for edgetts and voice-clone. Defaults are tuned for slower, documentary-style narration.",
    fields: [
      {
        key: "TTS_SPEED",
        desc: "Speech rate. 1.0 = neutral pace. Lower values slow the voice down. 0.93 default sounds slightly more cinematic and gives the listener more time to absorb each sentence.",
        examples: "Range 0.7–1.2  ·  default 0.93",
      },
      {
        key: "TTS_STABILITY",
        desc: "How consistent the voice sounds across the whole audio. Higher = more uniform, less variation. Lower = more expressive but can sometimes wobble.",
        examples: "Range 0–1  ·  default 0.6 (balanced for narration)",
      },
      {
        key: "TTS_SIMILARITY_BOOST",
        desc: "How closely the synthesized voice matches the source reference. Higher = more faithful to the original voice's character.",
        examples: "Range 0–1  ·  default 0.75",
      },
      {
        key: "TTS_STYLE",
        desc: "Expressiveness. 0 = calm, even delivery. Higher values inject more emotional inflection. Documentary voices usually sit around 0.1–0.2.",
        examples: "Range 0–1  ·  default 0.15",
      },
      {
        key: "TTS_USE_SPEAKER_BOOST",
        desc: "Strengthens the unique character of the speaker. Useful when you notice the voice drifting toward a generic sound. Leave at `1` unless the output sounds harsh.",
        examples: "1 = enabled  ·  0 = disabled  ·  empty = provider default",
      },
    ],
  },
  {
    title: "Sentence Pauses (ElevenLabs voices)",
    subtitle: "Inserts automatic breath pauses BETWEEN sentences within a single scene's TTS. Active for ElevenLabs voices — works through 69labs's gateway too. Note: pauses between SCENES are handled separately via SCENE_TAIL_SILENCE in Video Assembly below.",
    fields: [
      {
        key: "TTS_AUTO_PAUSE",
        desc: "Turns automatic pauses on. When off, ElevenLabs may rush through periods. Recommended on for any narration longer than 30 seconds.",
        examples: "1 = enabled  ·  empty = disabled",
      },
      {
        key: "TTS_PAUSE_DURATION",
        desc: "How long each pause is. Documentaries usually sit around 0.3–0.5s. Audiobooks can go up to 0.8s for a more reflective tempo.",
        examples: "Range 0.1–30 seconds  ·  default 0.4",
      },
      {
        key: "TTS_PAUSE_FREQUENCY",
        desc: "How often the pause is inserted. 1 = every sentence boundary. Higher numbers add the pause less often (e.g. 5 = every 5th boundary).",
        examples: "Range 1–100  ·  default 1",
      },
    ],
  },
  {
    title: "Images",
    subtitle: "Generates one still image per scene. The same image is then either used directly (Ken-Burns zoom) or as the first frame for an img2vid clip.",
    fields: [
      {
        key: "IMAGE_PROVIDER",
        desc: "Which service hosts the image model. 69labs is the default — it routes to Google, OpenAI, Black Forest, etc internally with a single key.",
        examples: "69labs  /  replicate  /  openai  /  fal",
      },
      {
        key: "IMAGE_MODEL",
        desc: "The specific model. For photorealism try `imagen-4` (Google) or `seedream-4.5`. For balance of quality and detail try `nano-banana-pro` (default). For maximum hyperreal style try `flux-2-pro` (2 credits per image).",
        examples: "nano-banana-pro, imagen-4, seedream-4.5, gpt-image-2, flux-2-pro",
      },
      {
        key: "IMAGE_RATIO",
        desc: "Aspect ratio of generated images. 16:9 for landscape YouTube videos, 9:16 for vertical Shorts/Reels, 1:1 for thumbnails.",
        examples: "16:9, 9:16, 1:1, 4:3, 3:4",
      },
      {
        key: "IMAGE_RESOLUTION",
        desc: "Output resolution where supported. 1k is fastest and costs 1 credit. 2k looks visibly sharper but costs 3 credits per image. 4k is overkill for 1080p video output.",
        examples: "1k  /  2k  /  4k",
      },
    ],
  },
  {
    title: "Animations (img2vid)",
    subtitle: "Turns selected images into short video clips with real motion. Optional — leave provider on `off` to keep everything as static Ken-Burns photos.",
    fields: [
      {
        key: "ANIMATION_PROVIDER",
        desc: "Service for img2vid. `off` skips animation entirely. `69labs` uses Google Veo or xAI Grok. `replicate`/`fal` open the door to Kling, Luma, Runway etc.",
        examples: "off  /  69labs  /  replicate  /  fal",
      },
      {
        key: "ANIMATION_MODEL",
        desc: "Specific model id. `veo-video` (Google Veo 3.1 Fast) is the highest quality option in 69labs. `grok-imagine-video` is a slightly different style. For Replicate, use `kwaivgi/kling-v1.6-pro` for cinematic motion.",
        examples: "veo-video, grok-imagine-video, kwaivgi/kling-v1.6-standard",
      },
      {
        key: "ANIMATION_RATIO_PERCENT",
        desc: "Percentage of scenes to animate. 100 = every scene is a video clip. 50 = half. 0 = none (Ken-Burns only).",
        examples: "0–100  ·  default 50",
      },
      {
        key: "ANIMATION_DISTRIBUTION",
        desc: "Which scenes get picked when ratio < 100. `first-half` puts video clips at the start (strong hook), photos at the end. `alternating` interleaves them. `random` picks scenes with motion keywords first.",
        examples: "first-half  /  alternating  /  random  /  all",
      },
      {
        key: "ANIMATION_DURATION",
        desc: "Length of each generated clip in seconds. Veo 3.1 Fast ignores this and always produces ~6 seconds. Other models honor it.",
        examples: "5  ·  some providers support 4–10",
      },
      {
        key: "ANIMATION_KEEP_VEO_AUDIO",
        desc: "Whether to keep the ambient audio Veo generates inside each clip. Default empty — we mute it so only the TTS narration is heard. Set `1` if you want Veo's atmospheric sound layered behind the narrator.",
        examples: "empty = mute  ·  1 = keep ambient audio",
      },
    ],
  },
  {
    title: "Video Assembly (FFmpeg)",
    subtitle: "Final stitching step. Controls output resolution, framerate, and how scenes transition into each other.",
    fields: [
      {
        key: "VIDEO_RESOLUTION",
        desc: "Final video resolution. 1920x1080 (1080p) is the YouTube standard. 1280x720 (720p) is smaller files but lower quality. Veo source clips are upscaled/downscaled to fit.",
        examples: "1920x1080, 1280x720, 3840x2160",
      },
      {
        key: "VIDEO_FPS",
        desc: "Frames per second. 24 is cinematic feel. 30 is YouTube standard. 60 is smoother motion but doubles render time and file size.",
        examples: "24, 30, 60",
      },
      {
        key: "SCENE_DURATION_SECONDS",
        desc: "Fallback clip duration when TTS audio length is somehow unknown. In normal operation this is never used because we measure actual audio length with ffprobe.",
        examples: "default 5",
      },
      {
        key: "TRANSITION_DURATION",
        desc: "Crossfade length between scenes in seconds. 0.5 is a gentle blend. 1.0 is more cinematic. 0 disables transitions (instant cuts — much faster to render but looks abrupt).",
        examples: "0.5 = smooth  ·  1.0 = cinematic  ·  0 = no transitions",
      },
      {
        key: "SCENE_TAIL_SILENCE",
        desc: "Silence appended to the END of every scene's audio before assembly. This is the ONLY way to get pauses BETWEEN scenes — ElevenLabs's TTS_AUTO_PAUSE only handles pauses INSIDE one TTS call (intra-scene), and since each scene is a separate TTS call, scene boundaries get no breath without this setting. Raise to 0.6–0.8 if the narration still feels rushed at sentence endings.",
        examples: "0 = no padding (back-to-back)  ·  0.4 = natural breath (default)  ·  0.8 = reflective pacing",
      },
    ],
  },
  {
    title: "Performance (Concurrency)",
    subtitle: "How many parallel API jobs and FFmpeg renders to run at once. Higher = faster but risks rate limits. Defaults are tuned for 69labs's limits.",
    fields: [
      {
        key: "IMAGE_CONCURRENCY",
        desc: "Simultaneous image jobs PER KEY. 69labs's hard limit is 7 per account. We default to 5 to leave headroom for retries. With N keys configured, the total parallel capacity = this × N. Raise to 7 for maximum speed if you don't see 403 errors.",
        examples: "default 5  ·  max 7 per 69labs account  ·  total = this × number of keys",
      },
      {
        key: "TTS_CONCURRENCY",
        desc: "Simultaneous TTS jobs PER KEY. ElevenLabs through 69labs has generous limits. With multiple keys, you also get multiple per-account character quotas. Total = this × number of keys.",
        examples: "default 3  ·  bump to 5–7 if you have a paid subscription with high quota",
      },
      {
        key: "ANIMATION_CONCURRENCY",
        desc: "Simultaneous img2vid jobs PER KEY. 69labs's hard limit is 5 per account. We default to 3 for retry headroom. Total = this × number of keys.",
        examples: "default 3  ·  max 5 per 69labs account",
      },
      {
        key: "ASSEMBLE_CONCURRENCY",
        desc: "How many FFmpeg clip renders happen in parallel. This is CPU-bound — set roughly to half your CPU core count. A 16-core machine can comfortably handle 6–8.",
        examples: "default 4  ·  raise on 8+ core CPUs",
      },
      {
        key: "ASSEMBLE_XFADE_CHUNKS",
        desc: "Splits the final crossfade pass into N chunks that run in parallel, then crossfades the chunks together. Massively speeds up assembly for long videos (100+ scenes) because FFmpeg's xfade filter is single-threaded per pair. With 4 chunks, a 100-scene xfade on an 8-core CPU drops from ~50 min to ~12-15 min. Set to 1 to disable (monolithic xfade). Auto-skipped if you have fewer than 3×chunks scenes (i.e. 12 with default 4).",
        examples: "1 = no chunking  ·  4 = default (4-8 core CPU)  ·  6-8 for 16+ core CPUs",
      },
    ],
  },
  {
    title: "Optional / Alternative Providers",
    subtitle: "You only need these if you want to bypass 69labs and call providers directly. Leave empty if you're using the default 69labs stack.",
    fields: [
      {
        key: "ELEVENLABS_API_KEY",
        desc: "Direct ElevenLabs API key. Only used when TTS_PROVIDER is set to `elevenlabs` (not `69labs`).",
        examples: "Sign up at https://elevenlabs.io → Profile → API Keys",
      },
      {
        key: "REPLICATE_API_TOKEN",
        desc: "Replicate token, for using Flux Schnell or Kling models directly without 69labs. Useful if you want pay-as-you-go pricing.",
        examples: "Sign up at https://replicate.com → Account → API Tokens",
      },
      {
        key: "FAL_API_KEY",
        desc: "fal.ai key — alternative to Replicate. Faster cold starts in some cases.",
        examples: "Sign up at https://fal.ai → API keys",
      },
      {
        key: "ANTHROPIC_API_KEY",
        desc: "Anthropic Claude key. Only used when SCENE_SPLIT_PROVIDER is `anthropic`. Claude is more thorough than Gemini Flash but costs more.",
        examples: "Sign up at https://console.anthropic.com",
      },
      {
        key: "OPENAI_API_KEY",
        desc: "OpenAI key — for backup TTS (gpt-4o-mini-tts) or gpt-image-2 images.",
        examples: "Sign up at https://platform.openai.com",
      },
    ],
  },
];

interface StatsResp {
  keyCount: number;
  perKey: { image: number; tts: number; anim: number };
  total: { image: number; tts: number; anim: number };
  assembleConcurrency: number;
  xfadeChunks: number;
  animationEnabled: boolean;
  animationRatio: number;
}

export default function AdvancedSettingsPage() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [stats, setStats] = useState<StatsResp | null>(null);

  async function load(reveal = false) {
    const [settingsR, statsR] = await Promise.all([
      fetch(`/api/settings${reveal ? "?reveal=1" : ""}`).then((r) => r.json()),
      fetch("/api/stats").then((r) => r.json()).catch(() => null),
    ]);
    setValues(settingsR);
    setStats(statsR);
    setRevealing(reveal);
  }

  useEffect(() => { load(false); }, []);

  async function save() {
    const cleaned = dropMaskedSecrets(values);
    const r = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cleaned),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({} as { error?: string }));
      alert(`Save failed: ${j.error || r.statusText}`);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    load(revealing);
  }

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>Advanced settings</h1>
      <p style={{ color: "#8a8aa0", marginBottom: 16, lineHeight: 1.6 }}>
        Tuning knobs for the pipeline. The defaults are already good for most cases — touch these only
        if you know what you're doing.{" "}
        <Link href="/settings" style={{ color: "#7c5cff" }}>← Back to Keys &amp; Drive</Link>
      </p>

      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 16,
          position: "sticky",
          top: 0,
          background: "var(--bg)",
          padding: "8px 0",
          zIndex: 10,
        }}
      >
        <button className="btn-secondary" onClick={() => load(!revealing)}>
          {revealing ? "Hide secret values" : "Reveal secret values (to edit)"}
        </button>
        <button className="btn" onClick={save}>{saved ? "Saved ✓" : "Save all changes"}</button>
      </div>

      {stats && stats.keyCount > 0 && (
        <div
          className="card"
          style={{
            marginBottom: 14,
            background: "linear-gradient(90deg, #14141d, #1a1a28)",
            borderColor: stats.keyCount >= 2 ? "#3a5a3a" : undefined,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
                ⚡ Current parallel capacity
                {stats.keyCount >= 2 && (
                  <span style={{ marginLeft: 8, color: "#6dd66d", fontSize: 12 }}>
                    × {stats.keyCount} keys
                  </span>
                )}
              </div>
              <div style={{ color: "#9090a8", fontSize: 13, lineHeight: 1.6 }}>
                <strong style={{ color: "#e8e8f0" }}>{stats.total.image}</strong> image jobs ·{" "}
                <strong style={{ color: "#e8e8f0" }}>{stats.total.anim}</strong> video jobs ·{" "}
                <strong style={{ color: "#e8e8f0" }}>{stats.total.tts}</strong> TTS jobs running at once
              </div>
            </div>
            <div style={{ color: "#5a5a70", fontSize: 11, textAlign: "right" }}>
              FFmpeg: {stats.assembleConcurrency} parallel clips
              <br />
              xfade chunks: {stats.xfadeChunks}
            </div>
          </div>
        </div>
      )}

      {GROUPS.map((g) => (
        <GroupCard key={g.title} group={g} values={values} setValues={setValues} />
      ))}
    </div>
  );
}

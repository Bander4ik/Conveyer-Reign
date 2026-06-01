# Conveyer

A **local pipeline for making faceless AI YouTube videos** — paste a script, get a
finished MP4: **script → scenes → voiceover + visuals → final video**.

The engine is **theme-agnostic**. It ships tuned for a **space / astronomy** channel
(in the style of [The Sky Lab](https://www.youtube.com/@TheSkyLab-u4j) and
[Interstellar Dreams](https://www.youtube.com/@InterstellarDreams-w5g)) — but that
theme lives entirely in the editable prompts, not in the code. Point the prompts at
cooking, history, finance, true crime, anything, and you get that niche instead.
See [Retheme it to your niche](#retheme-it-to-your-niche) below.

> 👋 **Brand new and don't know what npm / Node / API keys are?**
> Read [SETUP.md](./SETUP.md) — a non-technical, step-by-step install guide from zero.
> Come back here once the platform is running.
>
> 🔄 **Already running an older version?** See [UPDATING.md](./UPDATING.md) for
> step-by-step update instructions (ZIP and git, Mac and Windows). Your API keys,
> prompts, and runs are preserved automatically.

Everything is controlled from a local web UI:

- **/** — paste a script and run the pipeline
- **/runs** — history of all runs
- **/runs/[id]** — live status + log stream (SSE)
- **/prompts** — edit the system prompts (scene splitting, image style, motion style)
- **/settings** — API keys, model picks, performance tuning

---

## Quick start

### Prerequisites
- **Node.js 20+** — https://nodejs.org/ (works on macOS, Windows, Linux)
- **FFmpeg** — required for video assembly
  - **macOS:** `brew install ffmpeg` (install Homebrew first from https://brew.sh)
  - **Windows:** `winget install Gyan.FFmpeg` (open a fresh terminal after install)
  - **Linux:** `sudo apt install ffmpeg`
  - Or set `FFMPEG_PATH` in `/settings` to point at the binary directly

### Install + run
```bash
# macOS / Linux: just double-click these
install.command    # one-time, installs npm dependencies
start.command      # daily — starts dev server and opens browser

# Windows: same idea, .bat instead of .command
install.bat
start.bat

# Cross-platform alternative (any OS)
npm install
npm run dev
```

Then open http://localhost:3000.

> **First time on macOS?** When you double-click a `.command` file, macOS Gatekeeper
> may block it. Right-click the file → **Open** → confirm. After that, double-click works
> normally. If you see "Operation not permitted", run `chmod +x *.command` in Terminal first.

### Required keys
Open `/settings`. The top section, **Required API Keys**, shows the two keys you must
provide before anything works:

1. **`GOOGLE_API_KEY`** — Google AI Studio (Gemini), splits the script into scenes.
   Free tier is enough for testing. Get one at https://aistudio.google.com/app/apikey
2. **`LABS69_API_KEY`** — 69labs.vip. A single subscription covers **voiceover + images
   + video animation**. Sign up at https://69labs.vip, copy the key from your account.

That's it. All other settings have sensible defaults.

---

## Retheme it to your niche

The video style is **100% in the prompts**, not the code. Nothing in the pipeline knows
or cares that the defaults are about space. To switch the channel to a different topic,
open **/prompts** and edit three fields — no coding, no restart:

| Prompt | Controls | Default (space) |
|---|---|---|
| **Scene Split** | How the script becomes scenes, and what each scene's visual should depict | "The channel is space-focused — astronomy, astrophysics… stars, planets, nebulae… NO people in frame." |
| **Image Style** | The look applied to every generated image | "real-world astronomy footage style, NASA / ESA mission imagery…" |
| **Animation Motion** | How clips move | generic "subtle cinematic camera motion, gentle parallax…" |

For example, to make a **cooking** channel you'd rewrite the Scene Split prompt to
describe food/kitchen visuals, and the Image Style prompt to "appetising food
photography, warm kitchen light…". The engine does the rest exactly the same way.

Tip for visual flow: in the Scene Split prompt, tell Gemini to **carry the setting,
lighting and time-of-day forward across consecutive scenes** and only reset the visual
world when the script itself moves to a new topic. Gemini sees the whole script at once,
so it can keep neighbouring clips in one coherent world instead of cutting to an
unrelated shot every few seconds.

Changes take effect on the **next run**. The old runs keep whatever prompt they used.

---

## Characters (consistent people across scenes)

By default every scene's image is generated independently, so a person mentioned twice
can look different each time. The **Characters** feature locks a recurring person to a
single look across the whole video — a host/presenter, or the subject the video is about.

On the **New run** page, open the **Characters** box and add one or more people. For each,
give a **name** and either:

- **Describe** them in words ("weathered 18th-century pirate captain, black beard, red
  coat") — the app generates one reference portrait and locks it, or
- **Upload a photo**, or
- paste a public **Image URL**.

Tick **Host / main** for your presenter. You can mix a main character with others and
change the cast per video.

**How it works:** at the start of a run each character's reference image is prepared and
hosted, Gemini tags which scenes each character appears in, and those scenes are generated
with the reference passed to the image model (nano-banana) so the face, hair and clothing
stay consistent. Scenes that get an animated Veo clip inherit the same look automatically.

**Two things to know:**
- The scene-split prompt must **allow people** for tagging to fire. The shipped default is
  themed for space and says "no people" — retheme it on **/prompts** (see
  [Retheme it to your niche](#retheme-it-to-your-niche)) before using characters.
- A character stays visually consistent and can have subtle Veo motion, but this is **not**
  a lip-synced talking avatar.

Reference images are uploaded to a temporary public host (litterbox, auto-deleted after
72h) because the 69labs image API only accepts reference images by URL.

---

## Pipeline architecture

```
script
  │
  ▼
[1] scene_split   (Gemini → JSON array of scenes)
  │  each scene: { text, visual_prompt, duration_hint_sec }
  │  Long scripts (>3000 words) are auto-split into chunks and stitched back —
  │  so 1–2 hour videos work without hitting Gemini's output limit.
  ▼
[2] for each scene, in parallel (concurrency-limited, via a worker pool):
       ├─ TTS        (ElevenLabs voices via 69labs by default; Edge TTS / OpenAI optional) → mp3
       ├─ image      (nano-banana-pro via 69labs) → png
       └─ img2vid    (Veo via 69labs) → mp4
                     Only ~half the scenes get a real animated clip by default
                     (the FIRST half — see ANIMATION_RATIO_PERCENT / ANIMATION_DISTRIBUTION).
                     The rest become Ken-Burns (slow zoom/pan over the still image).
  │
  ▼
[3] assemble (FFmpeg) — each scene's (clip or Ken-Burns image) + its voiceover →
    one clip, then xfade every clip into final.mp4. Long videos assemble in a
    hierarchical, RAM-bounded pass so hundreds of clips don't crash FFmpeg.
```

Every stage logs to the database AND streams to the UI in real time over SSE.

### Defaults at a glance
| Stage | Default | Change in |
|---|---|---|
| Scene split | Gemini `gemini-flash-latest` | /settings |
| Voiceover | 69labs → ElevenLabs "Christopher", model `eleven_multilingual_v2`, speed 0.93 | /settings |
| Images | 69labs `nano-banana-pro`, 16:9, 1k | /settings |
| Animation | 69labs `veo-video`, 50% of scenes, first-half | /settings |
| Final video | 1920×1080, 30 fps, 0.5s crossfade | /settings |

---

## Where files are stored

- **Database** (settings, run records, logs):
  - macOS / Linux: `~/.conveyer-reign/reign.db`
  - Windows: `C:\Users\YOU\.conveyer-reign\reign.db`
  - ~1 MB
- **Run outputs** (audio, images, animations, clips, final.mp4):
  - default: `~/.conveyer-reign/runs/<run-folder>/`
  - configurable via `/settings → RUNS_OUTPUT_DIR`

For convenience the project also creates a symlink/junction at `data/runs` inside the
project folder pointing to the actual runs directory, so you can navigate to outputs from
either location.

> **macOS:** the default folder starts with `.` which means Finder hides it. To see it:
> in Finder press **⌘ + Shift + .** (period) to toggle hidden folders, or press
> **⌘ + Shift + G** and paste `~/.conveyer-reign/runs/`.

---

## Performance notes (long videos)

The pipeline is built to survive multi-hour scripts (1000+ scenes):

- **Long scripts auto-chunk** at sentence boundaries for scene-splitting, then merge
  back into one scene list — no manual splitting needed.
- **A worker pool** bounds how much the run holds in memory, so a 1500-scene run doesn't
  balloon RAM and lag your laptop.
- **Every 69labs call has a timeout** — a stalled connection aborts and retries instead
  of hanging the whole run forever.
- **The hourly-credit cap is handled gracefully** — when 69labs returns "hourly credit
  limit exceeded", the run *waits* for the window to reset and retries rather than
  failing. The run gets slower at the cap, but it doesn't crash.
- **The run page shows the most recent ~500 log lines** so the browser stays responsive
  even with tens of thousands of total log entries (the full history stays in the DB).

To go faster against your plan's hourly cap, paste **multiple 69labs API keys** (one per
line) in `/settings → LABS69_API_KEY` — each account has its own hourly bucket and the
pipeline load-balances across them.

---

## Editing the code

Most behavior lives in these files:

| Area | File |
|---|---|
| Scene splitter (Gemini / Claude) | `src/lib/services/scene-split.ts` |
| TTS providers (69labs / ElevenLabs / OpenAI) | `src/lib/services/tts.ts` |
| Image providers (69labs / Replicate / OpenAI / fal) | `src/lib/services/image-gen.ts` |
| img2vid providers (Veo via 69labs / Kling via Replicate) | `src/lib/services/img2vid.ts` |
| FFmpeg assembly (Ken-Burns, xfade) | `src/lib/services/video-assemble.ts` |
| Pipeline orchestrator | `src/lib/pipeline.ts` |
| Default prompts | `src/lib/prompts.ts` |
| Defaults for `/settings` fields | `src/lib/settings.ts` |

Every stage uses `log(runId, level, message, { stage, data })` — anything you log
shows up in the live UI automatically.

---

## What's next (potential improvements)

- Auto-generated subtitles burned in (Whisper or model-provided SRT).
- Background music with auto-ducking under the narrator.
- Batch mode: list of topics → N full videos overnight.
- Direct upload to YouTube via Data API once a run finishes.

---

## Security notes

`~/.conveyer-reign/reign.db` stores your API keys in plaintext **locally on your
machine**. The database is never pushed to git (`data/*.db` is in `.gitignore`) and it
lives outside the project tree so it can't accidentally be committed.

If you want multi-user deployment or stricter handling, move the secrets into a real vault.

---

## License

MIT — see [LICENSE](./LICENSE).

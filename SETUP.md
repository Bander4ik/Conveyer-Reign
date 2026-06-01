# Setup Guide — for non-technical users

This guide walks you through installing and running Conveyer Reign from absolute zero. If
you've never used Terminal or written a line of code in your life, this is the right document.

> **Are you on Windows?** The same steps work — see the "On Windows" notes inside each section.
> All file paths use `.command` on Mac and `.bat` on Windows; otherwise everything is identical.

There are five required parts, in order, plus one optional one:

1. [Install Node.js](#1-install-nodejs) — the engine the platform runs on
2. [Install FFmpeg](#2-install-ffmpeg) — used to stitch videos together
3. [Download Conveyer Reign](#3-download-conveyer-reign) — the project itself
4. [Get the two required API keys](#4-get-the-two-required-api-keys) — Google + 69labs
5. [Run your first video](#5-run-your-first-video)
6. [Optional: connect Google Drive](#6-optional--connect-google-drive) — auto-backup your videos

Each section lists what to click, what to paste, and what to expect. You can stop after any
section and come back later — the platform remembers where you left off. Part 6 is fully
optional — the platform works without it.

---

## 1. Install Node.js

Node.js is the program that runs the platform's code. You install it once and forget it.

### macOS

1. Open https://nodejs.org/ in Safari or Chrome.
2. Click the **green button on the left** labeled **"LTS"** (Recommended for Most Users).
   A `.pkg` file like `node-v20.x.x.pkg` starts downloading into your Downloads folder.
3. When it's done, **double-click the file** in Downloads. The installer opens.
4. Click **Continue → Continue → Agree → Install**. Enter your Mac password when prompted.
5. When you see "The installation was successful", click **Close**.

**Verify it worked:**

- Open **Spotlight** (⌘ + Space), type `Terminal`, press Enter. A small window opens.
- Type `node --version` and press Enter.
- If you see something like `v20.18.0`, Node is installed. Close Terminal.

> **On Windows:** download the `.msi` from the same page, double-click → Next → Next → Install.
> Verify by opening Command Prompt (`cmd`) and running `node --version`.

---

## 2. Install FFmpeg

FFmpeg stitches your generated audio and images into a final MP4. On Mac the easiest
installer is **Homebrew**.

### macOS — install Homebrew first (one-time)

If you've never used Homebrew before, install it now. It's the standard Mac package manager.

1. Open **Terminal** (Spotlight → "Terminal" → Enter).
2. Paste this single line and press Enter:
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
3. It will ask for your Mac password — type it and press Enter (the cursor won't move while you
   type, that's normal for password fields).
4. Wait 5–10 minutes for it to download and install. When it finishes, it tells you to run
   two more commands. Copy and run them — they look something like:
   ```bash
   echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
   eval "$(/opt/homebrew/bin/brew shellenv)"
   ```
   (On Intel Macs the path is `/usr/local/bin/brew` instead. Just paste what Homebrew tells you.)

### macOS — install FFmpeg

With Homebrew installed, in the same Terminal window paste:

```bash
brew install ffmpeg
```

Press Enter. It downloads for a couple of minutes and finishes on its own.

**Verify:** Type `ffmpeg -version` in Terminal. If you see a wall of text starting with
`ffmpeg version`, you're done.

> **On Windows:** open Command Prompt and run `winget install --id Gyan.FFmpeg`, then close
> the window and open a fresh one before verifying with `ffmpeg -version`.

---

## 3. Download Conveyer Reign

### Option A — Simplest: download a ZIP

1. Open https://github.com/Bander4ik/Conveyer-Reign in Safari/Chrome.
2. Click the green **"< > Code"** button near the top-right of the file list.
3. Click **"Download ZIP"** at the bottom of the dropdown.
4. The ZIP appears in your Downloads folder. **Double-click it** — macOS auto-extracts to a
   folder named `Conveyer-Reign-main`.
5. **Move that folder** somewhere you'll remember, like `~/Documents/Conveyer-Reign/`.
   (Just drag it from Downloads into Documents in Finder.)

### Option B — Easier to update later: use git

If "git" sounds scary, skip this and use Option A. This option lets you pull future updates
with one command.

1. Open Terminal.
2. Pick a folder to keep the project in (e.g. Documents):
   ```bash
   cd ~/Documents
   git clone https://github.com/Bander4ik/Conveyer-Reign.git
   ```
3. The project lands in `~/Documents/Conveyer-Reign/`.

### Make the launcher scripts runnable (Mac only)

When you download from GitHub, macOS doesn't automatically mark scripts as runnable.
Open Terminal and run:

```bash
cd ~/Documents/Conveyer-Reign      # or wherever you put the folder
chmod +x install.command start.command stop.command
```

(If you used Option B / git clone, this step is usually unnecessary — git preserves the
executable flag — but running `chmod +x` again does no harm.)

### Install the project's dependencies

1. Open the project folder in Finder.
2. **Double-click `install.command`**.
3. Terminal opens and starts downloading ~100 MB of helper code from npm.
4. Wait until you see **"Done! Run start.command to launch the app."**
5. Press any key to close the window.

This usually takes 1–3 minutes the first time. You only do this once.

> **macOS Gatekeeper:** the first time you double-click `.command` files, macOS may show
> "cannot be opened because it is from an unidentified developer". To fix: right-click the
> `.command` file → **Open** → click **Open** in the dialog. After this once, it remembers
> and future double-clicks work normally.
>
> **On Windows:** double-click `install.bat` instead — same flow, no Gatekeeper.

---

## 4. Get the two required API keys

The platform talks to two outside services. Each requires you to register and copy a "key"
(a long random string). 5 minutes total.

### 4a. Google AI key (free)

This powers the LLM that splits your script into individual scenes.

1. Open https://aistudio.google.com/app/apikey in your browser.
2. Sign in with any Google account.
3. Click the blue **"Create API key"** button.
4. A long string starting with `AIzaSy...` appears. Click the copy icon next to it.
5. **Open the Notes app** (macOS) and paste it temporarily — you'll need it in the next
   section. Don't share this key with anyone.

The free tier gives you generous limits — you won't pay anything for normal use.

### 4b. 69labs key (paid subscription)

This is the all-in-one key that covers voiceover, image generation, and video animation.

1. Open https://69labs.vip in your browser.
2. Sign up with email + password.
3. Pick a subscription plan that includes API access (look for plans that mention API in
   the feature list — usually anything from "Pro" tier and above).
4. After payment, go to your **Account → API keys** page.
5. Click **"Create new API key"** (or whatever the button is called).
6. A key starting with `vk_...` appears. Copy it.
7. Paste it into Notes alongside the Google key.

---

## 5. Run your first video

Now we tie everything together.

### Start the platform

1. Open the project folder in Finder.
2. **Double-click `start.command`**.
3. Terminal opens. After a few seconds it says **"Ready in 1.6s"** and your default browser
   opens to `http://localhost:3000`.
4. You see the Conveyer Reign home page with a "New run" form.

The Terminal window must stay open while you use the platform. Closing it stops the server.

> **On Windows:** double-click `start.bat` instead.

### Enter your API keys

1. In the sidebar on the left, click **"Keys & Settings"**.
2. The top section is **Required API Keys** with a red border. Two empty fields:
   `GOOGLE_API_KEY` and `LABS69_API_KEY`. They have red borders because they're empty.
3. Paste your Google key into `GOOGLE_API_KEY`.
4. Paste your 69labs key into `LABS69_API_KEY`.
5. Scroll to the top, click **"Save all changes"**. You should see "Saved ✓".

That's it for configuration. Everything else has sensible defaults.

> **About the two settings pages:** the sidebar has **"Keys & Settings"** (just the
> two required keys + optional Google Drive sync) and **"Advanced settings"** (every
> tuning knob — voice, images, animation, performance, storage path). For a first
> run you only need the two keys on the main page. Touch Advanced settings later,
> only if you want to fine-tune something.

### Generate your first video

1. Click **"New run"** in the sidebar.
2. Give the run a title — anything you want (e.g. `My first test`). This becomes the folder
   name on disk.
3. Paste a script into the big text box. For a first test, try something short — 200 words is
   enough to verify everything works without burning credits.
4. Below the script box you'll see live word count and estimated video length.
5. Click **"Run pipeline"**.

You're now on the run page. Live logs stream in from the server as work progresses:

- The script gets split into scenes (~10 seconds)
- Each scene's voiceover is generated in parallel (~10 seconds for short scripts)
- Each scene's image is generated in parallel (1–5 minutes depending on settings)
- FFmpeg stitches everything together (~1 minute for a 1-minute video)

When you see "Pipeline complete", scroll up. The final video appears at the top with a
play button, a Download button, and an "Open folder" button.

### Where everything lives

Generated files are saved here by default:

- **macOS:** `/Users/YOUR_USERNAME/.conveyer-reign/runs/YOUR_RUN_TITLE/`
- **Windows:** `C:\Users\YOUR_USERNAME\.conveyer-reign\runs\YOUR_RUN_TITLE\`

The folder starts with a dot, which means macOS hides it in Finder by default. The fastest
way to see it:
- Click the **"Open folder"** button on the run page → Finder opens it for you.
- Or in Finder, press **⌘ + Shift + .** (period) to toggle hidden folders on.
- Or in Finder, press **⌘ + Shift + G** and paste `~/.conveyer-reign/runs/`.

You can change this location in **Advanced settings → Storage Location → RUNS_OUTPUT_DIR**.

### Optional: keep a character consistent (a host, or the person the video is about)

Normally each scene's picture is created on its own, so the same person can come out looking
different from scene to scene. If your video has a **host** on camera, or is **about one
person** (a specific pirate, a historical figure), you can lock their look so they stay the
same every time they appear.

On the **New run** page, find the **Characters** box and click **"+ Add character"**:

1. Type the person's **name** (e.g. `Blackbeard`, or `Host`).
2. Choose how to set their look:
   - **Describe** — type what they look like (age, face, hair, clothing). The app creates one
     picture of them and reuses it everywhere.
   - **Upload photo** — pick an image of the person from your computer.
   - **Image URL** — paste a link to a picture that's already online.
3. Tick **"Host / main"** if this is your presenter.
4. Add more people the same way if the video needs them. You can use a different set of people
   for each video.

Then click **Run pipeline** as usual — that person now keeps the same face and outfit in every
scene they appear in.

> **Important — allow people in your prompt first.** The shipped Scene Split prompt is set up
> for a space channel and literally says "no people", so the app won't put anyone on screen.
> Before using characters, open **/prompts** and rewrite the Scene Split prompt for your real
> topic (pirates, history, …) with people allowed. See "Retheme it to your niche" in
> [README.md](./README.md).
>
> Note: the person looks consistent and can have slight motion, but this is **not** a talking
> avatar — their mouth won't lip-sync to the narration.

---

## 6. Optional — connect Google Drive

The platform can automatically upload every finished run to your Google Drive: the
final video into `Conveyer/Final Videos/`, and the raw scene clips plus a manifest
into `Conveyer/Clips Library/`. This gives you an off-machine backup and builds a
library of clips for reuse in future videos.

**This is optional.** Skip it entirely if you don't need cloud backup — everything
else works without it.

If you do want it:

1. In the platform, open **"Keys & Settings"** and scroll to the blue
   **"Google Drive Sync"** section.
2. Click **"First-time setup — how to get Client ID / Secret"** to expand the
   built-in step-by-step guide.
3. Follow it. It walks you through Google Cloud Console — creating a project,
   enabling the Google Drive API, **adding your own Gmail as a Test user**
   (don't skip this — it's the #1 mistake), creating an OAuth client, and
   pasting two values back into the platform.
4. Click **"Connect Google Drive"**, approve access in the browser tab that
   opens, and you'll get a green ✓.
5. Tick **"Auto-upload finished runs to Drive"** and save.

After that, a new **"Drive library"** link in the sidebar shows every run you've
uploaded. Full written walkthrough with troubleshooting is in
[UPDATING.md](./UPDATING.md#setting-up-google-drive-sync-after-youve-updated).

---

## Troubleshooting

### Mac: "cannot be opened because it is from an unidentified developer"
Right-click the `.command` file → **Open** → click **Open** in the dialog. This is macOS's
Gatekeeper — it accepts once and remembers.

### Mac: "Operation not permitted" when running `.command`
The executable bit got lost during download. Open Terminal in the project folder and run:
```bash
chmod +x *.command
```

### "Port 3000 is already in use"
Another copy of the server is still running. Double-click `stop.command` (Windows:
`stop.bat`) to kill it, then try `start.command` again.

### "ffmpeg: command not found" or assembly fails
Either FFmpeg isn't installed, or it isn't on your PATH. Easiest fix: in
**Advanced settings → Storage Location → FFMPEG_PATH**, paste the absolute path to FFmpeg.
- **Apple Silicon Mac (M1/M2/M3):** `/opt/homebrew/bin/ffmpeg`
- **Intel Mac:** `/usr/local/bin/ffmpeg`
- **Windows:** something like `C:\Users\YOU\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-X.X.X-full_build\bin\ffmpeg.exe`

### Mac: I don't know if I have an Apple Silicon or Intel Mac
Click the Apple logo (top-left) → **About This Mac**. Look at the "Chip" or "Processor" line.
"Apple M1/M2/M3/M4" = Apple Silicon. "Intel Core i...." = Intel.

### The pipeline says "GOOGLE_API_KEY is not set" even though you pasted it
Make sure you clicked **"Save all changes"** at the top of the settings page. After saving,
the field switches to masked dots — that means it saved correctly.

### A specific scene fails but the rest succeed
This is normal. AI services sometimes drop requests. The platform marks failed scenes and
keeps going. When the run finishes with errors, click **"Reassemble from existing assets"**
on the run page — it regenerates just the missing pieces.

### The voice "swallows" sentence endings or speaks too fast
Open **Advanced settings → Sentence Pauses**. Make sure `TTS_AUTO_PAUSE` is `1` and
`TTS_PAUSE_DURATION` is around `0.4`. For an even slower delivery, lower `TTS_SPEED` in
**Advanced settings → Voice Fine-Tuning** from `0.93` down to `0.88`.

### Images don't match the script's topic
The look-and-feel comes from the **scene_split** and **image_prompt** fields in `/prompts`.
The defaults are tuned for cosmic / astronomy content. If your channel is on a different
topic, edit `image_prompt` to remove space-specific styling, and edit `scene_split` to give
the LLM different visual direction.

### Generation is too slow
Open **Advanced settings → Performance (Concurrency)**. Raise `IMAGE_CONCURRENCY` to `6` or
`7` (7 is the 69labs hard limit). On a powerful CPU, raise `ASSEMBLE_CONCURRENCY` to `6`
or `8`.

---

## What to do next

- Read [README.md](./README.md) for the architecture overview.
- Open **Advanced settings** and read the inline descriptions — every field is explained.
- Edit the **Prompts** page to control visual style and how the LLM splits scripts.
- **Recurring characters:** on the New run page, use the **Characters** box to keep a host —
  or the person a video is about — looking the same across every scene (upload a photo or
  describe them). See [README.md](./README.md#characters-consistent-people-across-scenes).
  Note: your scene-split prompt must allow people (the space default says "no people").
- Increase `ANIMATION_RATIO_PERCENT` in **Advanced settings → Animations** if you want more
  video animation in your final output (it defaults to 50% — first half video, second half
  photos with Ken-Burns).
- Connect Google Drive (Part 6 above) so finished videos back up to the cloud automatically.

When a new version is released, see [UPDATING.md](./UPDATING.md) — it covers updating on
Mac and Windows, with or without git, without losing your keys or run history.

If you get stuck on something not covered here, open an Issue on the GitHub repository with
a screenshot of the error and the contents of the Terminal window.

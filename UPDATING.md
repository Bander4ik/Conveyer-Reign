# Updating Conveyer Reign

When a new version is published on GitHub, you can pull the changes without losing
your API keys, custom prompts, or generated runs. Your data lives in a separate
database **outside** the project folder, so replacing or updating the project never
touches it.

This guide covers all four combinations:

- [macOS · downloaded as ZIP](#macos--downloaded-as-zip)
- [macOS · using git clone](#macos--using-git-clone)
- [Windows · downloaded as ZIP](#windows--downloaded-as-zip)
- [Windows · using git clone](#windows--using-git-clone)

If you're not sure which method you used originally, check your project folder:
if there's a hidden `.git` folder inside, you used **git**. Otherwise it's a **ZIP**.

---

## What's new in this version

### Characters — consistent people across scenes 🎭

You can now keep a recurring person — a host, or the subject a video is about — looking
the same in every scene they appear in. On the **New run** page, open the **Characters**
box, add a person (upload a photo or describe them), and tick **Host / main** for your
presenter. Full walkthrough is in [SETUP.md](./SETUP.md). Reminder: your scene-split prompt
on **/prompts** must allow people (the space default says "no people").

### Google Drive sync 🚀

The platform can also auto-upload every finished run to your Google Drive, so
your videos and raw scene clips are backed up off your machine and available
for reuse in future videos. Three things to know:

1. **New sidebar link: "Drive library"** — browse every run you've uploaded to
   Drive, with links to each clip. Empty until you finish a run with Drive
   sync enabled.

2. **Settings page split into two**:
   - `/settings` is now just **Required API Keys + Google Drive sync**
     (the new feature you'll spend time configuring).
   - `/settings/advanced` is everything else (TTS, animation, performance,
     etc.) — also linked in the sidebar. Nothing was removed, just moved.

3. **A new "Google Drive Sync" section on /settings** with a built-in
   step-by-step setup guide. The guide walks you through Google Cloud
   Console (enable Drive API, add yourself as a Test user, create OAuth
   client, paste credentials, connect). Read this section **after**
   updating.

### What gets uploaded after each run

```
Your Google Drive:
   Conveyer/
     Final Videos/
       <run-folder-name>.mp4         ← share-ready final video
     Clips Library/
       <run-folder-name>/
         scene_001.mp4               ← raw Veo clip (no voiceover)
         scene_002.mp4
         ...
         clips.json                  ← machine-readable manifest
         description.md              ← human-readable summary
```

Drive sync is **off by default** — runs that finish before you turn it on
behave exactly as today. To enable it: update the project (sections below),
then follow the in-app setup guide on `/settings`.

### Coming next (heads-up only — not in this release yet)

The AI clip-search will scan your library before generating new clips and
reuse anything visually relevant — so over time your 69labs spend drops.
The infrastructure (manifests, library API, search backend) is already in
place; the UI for picking clips is what's left.

---

## What gets updated vs preserved

```
🏠 Your home folder
│
├── 📁 ~/.conveyer-reign/        ← NEVER touched by updates
│   ├── 📄 reign.db                  ← all your data lives here:
│   │                                    • API keys (Google, 69labs)
│   │                                    • custom prompts
│   │                                    • run history
│   │                                    • every setting you changed
│   │
│   └── 📁 runs/                       ← all generated files:
│       ├── 📁 My first test/
│       │   ├── 📄 final.mp4
│       │   ├── 📁 audio/   (mp3s)
│       │   ├── 📁 images/  (pngs)
│       │   └── 📁 clips/
│       └── 📁 other runs...
│
└── 📁 Documents/Conveyer-Reign/          ← THIS is what gets replaced/updated
    ├── 📁 src/                         (just code)
    ├── 📁 node_modules/                (libraries — reinstalled if needed)
    ├── 📄 start.command
    ├── 📄 package.json
    └── ... (no personal data here)
```

**Rule of thumb:** the project folder only contains code logic. Everything you
personally entered or generated lives in `~/.conveyer-reign/` and stays put.

---

## macOS · downloaded as ZIP

### 1. Stop the running server

If `start.command` is still running, close its Terminal window or press Ctrl+C
inside it. Or double-click `stop.command` in your current project folder.

### 2. Rename your current project folder

In Finder, find your existing `Conveyer-Reign-main` (or `Conveyer`) folder.
Right-click → **Rename** → call it something like `Conveyer-OLD` so you don't
mix things up.

### 3. Download the new ZIP

1. Open https://github.com/Bander4ik/Conveyer-Reign in your browser.
2. Click the green **"< > Code"** button (top-right of the file list).
3. Click **"Download ZIP"** at the bottom of the dropdown.
4. The file `Conveyer-Reign-main.zip` lands in your Downloads folder.

### 4. Extract and move it into place

1. In Downloads, double-click `Conveyer-Reign-main.zip`. macOS unzips it into a
   folder called `Conveyer-Reign-main`.
2. Drag that folder to wherever you keep the project (e.g. `~/Documents/`).
3. Rename it back to whatever name you had before (so any shortcuts still work).

### 5. Restore executable permissions on the launchers

macOS strips the executable flag during ZIP extraction. Open Terminal
(⌘+Space → "Terminal") and run:

```bash
cd ~/Documents/Conveyer-Reign
chmod +x *.command
```

(Replace `~/Documents/Conveyer-Reign` with your actual path. **Tip:** type `cd ` with
a trailing space, then drag the folder from Finder into Terminal — it auto-fills
the path. Press Enter.)

### 6. Reinstall dependencies

Double-click `install.command` in the new folder. Terminal downloads ~100 MB of
helper code (1–3 minutes).

> **If macOS Gatekeeper blocks it:** right-click `install.command` → **Open**
> → click **Open** in the warning dialog. macOS remembers after the first
> approval.

### 7. Start the new version

Double-click `start.command`. Your browser opens at http://localhost:3000.

### 8. Verify your data is still there

- **Keys & Settings** — your `GOOGLE_API_KEY` and `LABS69_API_KEY` should
  still be there (shown as `AIzaS…x7Ag` etc).
- **Prompts** — any prompts you customized are still there.
- **Run history** — all your previous runs are accessible.
- New fields from the update appear with default values.

### 9. Delete the old folder (after you verify)

Once you've confirmed everything in step 8, drag `Conveyer-OLD` to Trash and
empty it. It contains ~200 MB of obsolete `node_modules` plus the old code.

---

## macOS · using git clone

### 1. Stop the running server (same as above)

### 2. Pull the latest changes

Open Terminal and run:

```bash
cd ~/Documents/Conveyer-Reign    # or wherever you cloned it
git pull
```

If `git pull` reports "local changes would be overwritten", run this first:

```bash
git stash
git pull
```

That sets aside any accidental local edits — they're not your settings, so
nothing important is lost.

### 3. Make sure launchers are still executable

```bash
chmod +x *.command
```

(Usually unnecessary because git preserves the executable bit, but harmless.)

### 4. Start the updated version

Double-click `start.command`. Browser opens at http://localhost:3000.

That's it — no reinstall step needed unless `package.json` changed (in which
case `start.command` runs `npm install` automatically).

---

## Windows · downloaded as ZIP

### 1. Stop the running server

If `start.bat` is still running, close its black window or press Ctrl+C in it.
Or double-click `stop.bat` in your current project folder.

### 2. Rename your current project folder

In File Explorer, right-click your existing `Conveyer-Reign-main` (or `Conveyer`)
folder → **Rename** → `Conveyer-OLD`.

### 3. Download the new ZIP

1. Open https://github.com/Bander4ik/Conveyer-Reign in your browser.
2. Click **"< > Code"** → **"Download ZIP"**.
3. Save to Downloads.

### 4. Extract it into place

1. Right-click `Conveyer-Reign-main.zip` → **Extract All...** → pick the same
   location your project was in (e.g. `C:\YouTube\`) → **Extract**.
2. Rename the new `Conveyer-Reign-main` folder to whatever name you had before.

### 5. Reinstall dependencies

Double-click `install.bat` in the new folder. A black window opens and
downloads ~100 MB of helper code (1–3 minutes). When it says "Done!", close.

### 6. Start the new version

Double-click `start.bat`. Your browser opens at http://localhost:3000.

### 7. Verify your data

Same as macOS step 8 above — open Keys & Settings, Prompts, Run history. Your
data is preserved because the database lives in `C:\Users\YOU\.conveyer-reign\`,
which we never touched.

### 8. Delete the old folder

Drag `Conveyer-OLD` to the Recycle Bin once you're sure the new version is
fine. It only contains code and node_modules — no personal data.

---

## Windows · using git clone

### 1. Stop the running server (same as above)

### 2. Pull the latest changes

Open PowerShell (Start menu → "PowerShell") and run:

```powershell
cd "C:\YouTube\Conveyer-Reign"    # or wherever you cloned it
git pull
```

If `git pull` complains about local changes:

```powershell
git stash
git pull
```

### 3. Start the updated version

Double-click `start.bat`. Browser opens at http://localhost:3000.

If `package.json` changed in the update, the launcher will auto-run
`npm install` for you on first boot.

---

## Setting up Google Drive sync (after you've updated)

Skip if you're not interested in Drive sync — everything else works the same.

### One-time Google Cloud Console setup (~5 minutes)

You need an OAuth Client ID and Secret from Google to let the platform write
to your Drive on your behalf. The full step-by-step is **built into the
Settings page** — click **"First-time setup — how to get Client ID / Secret"**
on `/settings` and follow the 10 numbered steps. Short summary:

1. Open https://console.cloud.google.com/ using the Gmail account that owns
   the Drive you want files saved to.
2. Create a new project (any name — "Conveyer" works).
3. **APIs & Services → Library → Google Drive API → Enable**.
4. **APIs & Services → OAuth consent screen → External**. Fill the required
   fields (app name, support email, developer email) and save.
5. **⚠ DO NOT SKIP THIS STEP.** Still on the OAuth consent screen, open the
   **Audience** (or **Test users**) section → **Add users** → type the EXACT
   Gmail address you'll log in with when connecting → Save. **If you skip
   this, step 9 fails** with `Access blocked: ... has not completed the
   Google verification process` / `Error 403: access_denied`.
6. **APIs & Services → Credentials → Create OAuth client → Web Application**.
7. Add authorized redirect URI:
   `http://localhost:3000/api/gdrive/oauth/callback`
8. Copy the **Client ID** and **Client Secret** Google shows you. Paste them
   into `GDRIVE_CLIENT_ID` and `GDRIVE_CLIENT_SECRET` on the `/settings` page
   → **Save all changes**.
9. Click **Connect Google Drive**. A browser tab opens; log in with the same
   Gmail you added as a Test user in step 5; approve access (you'll see a
   "Google hasn't verified this app" warning — click **Continue**, it's
   normal for personal projects).
10. Back on `/settings`, you should see a green ✓ "Connected as your@gmail".

### Enable auto-upload

Tick the **"Auto-upload finished runs to Drive"** checkbox in the Google Drive
Sync section → Save again. Now every successful pipeline run uploads its files
to Drive automatically.

### Verify it worked

Start a small pipeline run with 2–3 scenes. When it finishes, check:

- Your Google Drive → `Conveyer/Final Videos/<run-name>.mp4` is there.
- Your Google Drive → `Conveyer/Clips Library/<run-name>/` contains
  `scene_001.mp4`, `scene_002.mp4`, `clips.json`, `description.md`.
- The platform's **"Drive library"** sidebar link shows your run with each
  scene listed.

### If something goes wrong

The status banner on `/settings` tells you exactly what's broken and
sometimes includes a direct link to fix it (e.g. "Drive API not enabled" →
clickable Enable URL). Common cases:

- **"Access blocked: ... has not completed the Google verification process"
  / "Error 403: access_denied"** — the Gmail you logged in with is NOT in
  your project's Test users list. This is the #1 setup mistake. Fix: Google
  Cloud Console → APIs & Services → OAuth consent screen → Audience / Test
  users → **Add users** → add that exact email → Save → click **Connect
  Google Drive** again. It's purely a Google Cloud setting — nothing to
  change in the app.
- **"Drive API is not enabled"** — click the link in the banner, hit Enable,
  wait a minute, refresh `/settings`.
- **"Token expired or revoked"** — click **Reconnect** in the Drive Sync
  section.
- **Upload failed mid-run** — local files stay intact. From the run page
  click the **Drive** card to retry a manual sync.

---

## Troubleshooting

### "Permission denied" when running `.command` on Mac
You skipped the `chmod +x *.command` step. Open Terminal, navigate to the
project folder, and run it.

### "cannot be opened because it is from an unidentified developer" (macOS Gatekeeper)
Right-click the `.command` file → **Open** → click **Open** in the dialog.
This is a one-time approval per file.

### Port 3000 is already in use
A previous server is still alive. Double-click `stop.command` (Mac) or
`stop.bat` (Windows), then start again.

### My new field doesn't appear in Keys & Settings
The platform seeds defaults for new fields on server start. If you don't see
the new field, make sure you fully stopped the old server before starting the
new one. The seed only runs when the dev server boots fresh.

### I see "node_modules not found" on first start
That's normal — the launcher detects this and runs `npm install` automatically.
Just wait 1–3 minutes.

### I want to back up my data before updating (peace of mind)
- **macOS:** Open Finder → ⌘+Shift+G → paste `~/.conveyer-reign/` →
  right-click the folder → **Compress** to make a ZIP backup.
- **Windows:** open File Explorer → paste `%USERPROFILE%\.conveyer-reign\`
  in the address bar → right-click → **Send to → Compressed (zipped) folder**.

You don't need this step — updates physically can't reach that folder — but it
never hurts.

---

## Why your data is safe (technical detail, optional reading)

The platform stores two completely separate things in two completely separate
places:

| What | Where | Touched by updates? |
|---|---|---|
| Source code & launchers | The project folder you downloaded | ✅ replaced by update |
| API keys, prompts, settings, runs | `~/.conveyer-reign/` in your home directory | ❌ never touched |

The Node.js server reads the database from your home directory regardless of
where the project folder is. So if you replace the project folder with a new
version, the new code reads the same database and finds everything you
configured exactly as you left it.

This is the same pattern most desktop apps use: the program lives in
`Applications` (or `Program Files`) and gets replaced with each update, while
your personal data lives in `~/Library` (or `AppData`) and survives forever.

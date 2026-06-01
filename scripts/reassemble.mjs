// Standalone CLI that reassembles final.mp4 from existing audio + images in a run folder.
// Useful for recovery when the dev server can't be started but the assets are on disk.
//
// Usage: node scripts/reassemble.mjs <runId>
//
// runId can be either a UUID or a folder_name (whatever appears in the DB).
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

const runId = process.argv[2];
if (!runId) {
  console.error("Usage: node scripts/reassemble.mjs <runId>");
  process.exit(1);
}

const DATA_DIR = process.env.REIGN_DATA_DIR ?? path.join(os.homedir(), ".conveyer-reign");

const Database = (await import("better-sqlite3")).default;
const db = new Database(path.join(DATA_DIR, "reign.db"));
const ffmpegPath = db.prepare("SELECT value FROM settings WHERE key='FFMPEG_PATH'").get()?.value;
const resolution = db.prepare("SELECT value FROM settings WHERE key='VIDEO_RESOLUTION'").get()?.value || "1920x1080";
const fps = Number(db.prepare("SELECT value FROM settings WHERE key='VIDEO_FPS'").get()?.value || "24");
if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  console.error("FFMPEG_PATH is missing or invalid:", ffmpegPath);
  process.exit(1);
}
const [w, h] = resolution.split("x").map(Number);

// Try both the runs folder lookup and direct folder name
const runsRootSetting = db.prepare("SELECT value FROM settings WHERE key='RUNS_OUTPUT_DIR'").get()?.value?.trim();
const runsRoot = runsRootSetting && runsRootSetting.length > 0 ? runsRootSetting : path.join(DATA_DIR, "runs");
const runDir = path.join(runsRoot, runId);
if (!fs.existsSync(runDir)) {
  console.error("Run directory not found:", runDir);
  process.exit(1);
}

const audioDir = path.join(runDir, "audio");
const imgDir = path.join(runDir, "images");
const clipsDir = path.join(runDir, "clips");
fs.mkdirSync(clipsDir, { recursive: true });

const audios = fs.readdirSync(audioDir).filter((f) => f.endsWith(".mp3")).sort();
console.log(`Found ${audios.length} scenes`);

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg exited with " + code))));
  });
}

const clipPaths = [];
for (const a of audios) {
  const idx = a.match(/scene_(\d+)\.mp3/)[1];
  const audioPath = path.join(audioDir, a);
  const imagePath = path.join(imgDir, `scene_${idx}.png`);
  const clipPath = path.join(clipsDir, `clip_${idx}.mp4`);
  if (!fs.existsSync(imagePath)) {
    console.warn(`! no image for scene ${idx} — skipping`);
    continue;
  }
  console.log(`→ Clip ${idx}…`);
  const zoom = `scale=${w * 2}:${h * 2},zoompan=z='min(zoom+0.0008,1.1)':d=1:s=${w}x${h}:fps=${fps}`;
  await run([
    "-y",
    "-loop", "1", "-i", imagePath,
    "-i", audioPath,
    "-vf", zoom,
    "-r", String(fps),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart",
    clipPath,
  ]);
  clipPaths.push(clipPath);
}

const listFile = path.join(clipsDir, "concat.txt");
fs.writeFileSync(listFile, clipPaths.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));

const finalPath = path.join(runDir, "final.mp4");
console.log(`→ Concat → ${finalPath}`);
await run(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", finalPath]);

console.log(`✅ Done: ${finalPath}`);

// Mark run as done in the DB. Match by folder_name OR id.
const updated = db.prepare(
  "UPDATE runs SET status='done', output_path=?, updated_at=datetime('now') WHERE id=? OR folder_name=?"
).run(finalPath, runId, runId);
console.log(`Run marked done (${updated.changes} row updated).`);

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * Data dir holds the SQLite database (settings, run records, logs).
 * Lives outside the project source tree so Turbopack file-watcher doesn't try
 * to scan SQLite shm/wal files (which can be locked on Windows).
 *
 * Override via REIGN_DATA_DIR environment variable.
 */
const DATA_DIR =
  process.env.REIGN_DATA_DIR ??
  path.join(os.homedir(), ".conveyer-reign");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "reign.db"));
// Without WAL: on Windows the .shm file can lock external readers.
db.pragma("journal_mode = DELETE");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prompts (
    name TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    title TEXT,
    folder_name TEXT,
    status TEXT NOT NULL,
    script TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    output_path TEXT
  );

  CREATE TABLE IF NOT EXISTS run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    -- ISO 8601 with Z so the client renders local time correctly
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    level TEXT NOT NULL,
    stage TEXT,
    message TEXT NOT NULL,
    data_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_run_logs_run ON run_logs(run_id, id);
`);

// Channels — per-channel prompt profiles + a `battle_card` flag. Empty prompt
// fields fall back to the global /prompts defaults at resolve time. (Each
// scene's visual type — AI / real photo / real person — is decided per scene by
// the scene-split prompt, not by a channel-wide switch.)
db.prepare(`
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scene_split TEXT NOT NULL DEFAULT '',
    image_prompt TEXT NOT NULL DEFAULT '',
    animation_motion TEXT NOT NULL DEFAULT '',
    data_mode TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`).run();

// Channels v2 — `battle_card` is the live stat-card flag (owned by channels.ts).
// Back-fill it ONCE for legacy rows that predate the column (battle_card IS
// NULL); rows the app has written always have a non-null battle_card, so this
// never re-runs on them and a user's toggle is never clobbered on restart.
// (The legacy `data_mode` / `visual_source` columns are deprecated and unread —
// kept only so older DBs don't error.)
tryAddColumn("channels", "battle_card TEXT");
db.prepare(
  `UPDATE channels SET battle_card = CASE WHEN data_mode = 'battle' THEN '1' ELSE '0' END
   WHERE battle_card IS NULL`
).run();

// Channels v3 — per-channel visual-mix + audio config. NULL on rows that predate
// these columns; channels.ts mapRow fills sensible defaults, so no back-fill here.
tryAddColumn("channels", "clips_source TEXT");
tryAddColumn("channels", "clips_ratio TEXT");
tryAddColumn("channels", "stills_source TEXT");
tryAddColumn("channels", "real_subjects TEXT");
tryAddColumn("channels", "voiceover TEXT");
tryAddColumn("channels", "keep_clip_audio TEXT");

// Channels v4 — per-channel TTS voice override. Empty/NULL = use global TTS_VOICE_ID.
tryAddColumn("channels", "voice_id TEXT");

// Migrations for older DBs. SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT
// EXISTS`, so we attempt and ignore failure when the column already exists.
function tryAddColumn(table: string, columnDecl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDecl}`);
  } catch {
    // column already exists
  }
}

tryAddColumn("runs", "folder_name TEXT");
// Google Drive references — set by run-upload.ts after a successful sync.
tryAddColumn("runs", "drive_clips_folder_id TEXT");
tryAddColumn("runs", "drive_final_video_id TEXT");
tryAddColumn("runs", "drive_synced_at TEXT");
// Reuse map — JSON `{ "<scene_index>": "<drive_file_id>" }`. When present,
// the pipeline skips video generation for those scenes and downloads from Drive.
tryAddColumn("runs", "reuse_map_json TEXT");

export default db;

#!/usr/bin/env node
/**
 * Rolls back the shared DB to settings v1 (Conveyer Reign) understands.
 *
 * The shared SQLite DB at ~/.conveyer-reign/reign.db is used by BOTH v1
 * and v2 (Conveyer 2.0). v2 wrote provider names like "algrow" / "geminigen"
 * that v1 doesn't recognize, so v1 crashes on every pipeline run with
 * "Unknown TTS provider: algrow".
 *
 * This script only touches keys that v1 actually reads, and only if their
 * current value isn't one v1 accepts. Anything else is left alone.
 *
 * Also restores LABS69_API_KEY from the value the user shared in chat,
 * because the existing one in DB is the masked placeholder ("vk_o…6u3B")
 * left over from an earlier save-masked-secret bug.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

const DATA_DIR =
  process.env.REIGN_DATA_DIR ?? path.join(os.homedir(), ".conveyer-reign");
const DB_PATH = path.join(DATA_DIR, "reign.db");

if (!fs.existsSync(DB_PATH)) {
  console.error(`DB not found at ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH);
const get = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsert = db.prepare(
  "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
);

// Reset rules:
//   Each entry says: "if current value is BAD (matches the regex / list),
//   set it to this v1-valid REPLACEMENT". Otherwise leave it alone.
const rules = [
  // Provider names v1 doesn't know — force back to 69labs (v1's default)
  ["TTS_PROVIDER",       (v) => (v === "algrow"     ? "69labs" : null)],
  ["IMAGE_PROVIDER",     (v) => (v === "off"        ? "69labs" : null)],
  ["ANIMATION_PROVIDER", (v) => (v === "geminigen"  ? "69labs" : null)],

  // ANIMATION_MODEL: v2 uses "veo-3", "veo-3-fast"; v1 wants "veo-video"
  ["ANIMATION_MODEL", (v) => (/^veo-3/i.test(v) ? "veo-video" : null)],

  // v2 may have written IMAGE_RESOLUTION="2K" / "4K" — v1 lowercases them
  ["IMAGE_RESOLUTION", (v) => (v === "2K" ? "2k" : v === "4K" ? "4k" : null)],

  // The masked-secret placeholder needs to be replaced with the real key
  ["LABS69_API_KEY", (v) =>
    v.includes("…") ? "vk_on8xCFn0vFp6x9bLVhr6kfKv7h5K6u3B" : null,
  ],
];

let changes = 0;
for (const [key, transform] of rules) {
  const row = get.get(key);
  const cur = row?.value ?? "";
  const next = transform(cur);
  if (next !== null && next !== cur) {
    upsert.run(key, next);
    const display = key.includes("KEY") || key.includes("TOKEN")
      ? `${cur.slice(0, 5)}…${cur.slice(-4)} → ${next.slice(0, 5)}…${next.slice(-4)}`
      : `${JSON.stringify(cur)} → ${JSON.stringify(next)}`;
    console.log(`  ✓ ${key.padEnd(22)} ${display}`);
    changes++;
  }
}

db.close();

if (changes === 0) {
  console.log("\nNothing to reset — DB already looks v1-compatible.");
} else {
  console.log(`\nReset ${changes} key(s). v1 should run without 'Unknown provider' errors now.`);
  console.log("\nRestart v1 (close start.bat window, run it again) and try the pipeline.");
}

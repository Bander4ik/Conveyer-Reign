import db from "./db";
import { getPrompt } from "./prompts";

export type DataMode = "none" | "science" | "battle";

export interface Channel {
  id: string;
  name: string;
  scene_split: string;
  image_prompt: string;
  animation_motion: string;
  data_mode: DataMode;
  created_at?: string;
  updated_at?: string;
}

/** Prompts + data mode resolved for a run (channel overrides, global fallback). */
export interface ResolvedChannel {
  channelId: string | null;
  channelName: string | null;
  sceneSplit: string;
  imageStyle: string;
  animationMotion: string;
  dataMode: DataMode;
}

const listStmt = db.prepare(
  "SELECT id, name, scene_split, image_prompt, animation_motion, data_mode, created_at, updated_at FROM channels ORDER BY name COLLATE NOCASE"
);
const getStmt = db.prepare(
  "SELECT id, name, scene_split, image_prompt, animation_motion, data_mode FROM channels WHERE id = ?"
);
const upsertStmt = db.prepare(
  `INSERT INTO channels (id, name, scene_split, image_prompt, animation_motion, data_mode, updated_at)
   VALUES (@id, @name, @scene_split, @image_prompt, @animation_motion, @data_mode, datetime('now'))
   ON CONFLICT(id) DO UPDATE SET
     name = excluded.name,
     scene_split = excluded.scene_split,
     image_prompt = excluded.image_prompt,
     animation_motion = excluded.animation_motion,
     data_mode = excluded.data_mode,
     updated_at = datetime('now')`
);
const deleteStmt = db.prepare("DELETE FROM channels WHERE id = ?");

function normMode(m: unknown): DataMode {
  return m === "science" || m === "battle" ? m : "none";
}

export function listChannels(): Channel[] {
  return (listStmt.all() as Channel[]).map((c) => ({ ...c, data_mode: normMode(c.data_mode) }));
}

export function getChannel(id: string): Channel | null {
  const row = getStmt.get(id) as Channel | undefined;
  if (!row) return null;
  return { ...row, data_mode: normMode(row.data_mode) };
}

export function upsertChannel(c: {
  id: string;
  name: string;
  scene_split?: string;
  image_prompt?: string;
  animation_motion?: string;
  data_mode?: string;
}): void {
  upsertStmt.run({
    id: c.id,
    name: (c.name ?? "").trim() || "Untitled channel",
    scene_split: c.scene_split ?? "",
    image_prompt: c.image_prompt ?? "",
    animation_motion: c.animation_motion ?? "",
    data_mode: normMode(c.data_mode),
  });
}

export function deleteChannel(id: string): void {
  deleteStmt.run(id);
}

/**
 * Resolve the prompts + data mode for a run. A channel's empty prompt fields
 * fall back to the global /prompts defaults, so a channel only overrides what it
 * customizes. No channel (or unknown id) → all global defaults, data mode none.
 */
export function resolveChannel(channelId: string | null | undefined): ResolvedChannel {
  const globalScene = getPrompt("scene_split");
  const globalImage = getPrompt("image_prompt");
  const globalMotion = getPrompt("animation_motion");

  const ch = channelId ? getChannel(channelId) : null;
  if (!ch) {
    return {
      channelId: null,
      channelName: null,
      sceneSplit: globalScene,
      imageStyle: globalImage,
      animationMotion: globalMotion,
      dataMode: "none",
    };
  }
  return {
    channelId: ch.id,
    channelName: ch.name,
    sceneSplit: ch.scene_split.trim() || globalScene,
    imageStyle: ch.image_prompt.trim() || globalImage,
    animationMotion: ch.animation_motion.trim() || globalMotion,
    dataMode: ch.data_mode,
  };
}

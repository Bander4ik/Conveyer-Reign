import db from "./db";
import { getPrompt } from "./prompts";

export interface Channel {
  id: string;
  name: string;
  scene_split: string;
  image_prompt: string;
  animation_motion: string;
  /** Add an intro "VS" stat card at the start of the video. */
  battle_card: boolean;
  created_at?: string;
  updated_at?: string;
}

/** Prompts + behavior resolved for a run (channel overrides, global fallback). */
export interface ResolvedChannel {
  channelId: string | null;
  channelName: string | null;
  sceneSplit: string;
  imageStyle: string;
  animationMotion: string;
  battleCard: boolean;
}

const listStmt = db.prepare(
  "SELECT id, name, scene_split, image_prompt, animation_motion, battle_card, created_at, updated_at FROM channels ORDER BY name COLLATE NOCASE"
);
const getStmt = db.prepare(
  "SELECT id, name, scene_split, image_prompt, animation_motion, battle_card FROM channels WHERE id = ?"
);
const upsertStmt = db.prepare(
  `INSERT INTO channels (id, name, scene_split, image_prompt, animation_motion, battle_card, updated_at)
   VALUES (@id, @name, @scene_split, @image_prompt, @animation_motion, @battle_card, datetime('now'))
   ON CONFLICT(id) DO UPDATE SET
     name = excluded.name,
     scene_split = excluded.scene_split,
     image_prompt = excluded.image_prompt,
     animation_motion = excluded.animation_motion,
     battle_card = excluded.battle_card,
     updated_at = datetime('now')`
);
const deleteStmt = db.prepare("DELETE FROM channels WHERE id = ?");

function toBool(v: unknown): boolean {
  return v === 1 || v === "1" || v === true;
}

interface Row {
  id: string;
  name: string;
  scene_split: string;
  image_prompt: string;
  animation_motion: string;
  battle_card: unknown;
  created_at?: string;
  updated_at?: string;
}
function mapRow(r: Row): Channel {
  return {
    id: r.id,
    name: r.name,
    scene_split: r.scene_split,
    image_prompt: r.image_prompt,
    animation_motion: r.animation_motion,
    battle_card: toBool(r.battle_card),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function listChannels(): Channel[] {
  return (listStmt.all() as Row[]).map(mapRow);
}

export function getChannel(id: string): Channel | null {
  const r = getStmt.get(id) as Row | undefined;
  return r ? mapRow(r) : null;
}

export function upsertChannel(c: {
  id: string;
  name: string;
  scene_split?: string;
  image_prompt?: string;
  animation_motion?: string;
  battle_card?: boolean | string;
}): void {
  upsertStmt.run({
    id: c.id,
    name: (c.name ?? "").trim() || "Untitled channel",
    scene_split: c.scene_split ?? "",
    image_prompt: c.image_prompt ?? "",
    animation_motion: c.animation_motion ?? "",
    battle_card: toBool(c.battle_card) ? "1" : "0",
  });
}

export function deleteChannel(id: string): void {
  deleteStmt.run(id);
}

/**
 * Resolve the prompts + behavior for a run. A channel's empty prompt fields fall
 * back to the global /prompts defaults. No channel → global prompts, no stat card.
 * (The visual type of each scene — AI / real photo / real person — is decided
 * per scene by the scene-split prompt, not by a channel-wide switch.)
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
      battleCard: false,
    };
  }
  return {
    channelId: ch.id,
    channelName: ch.name,
    sceneSplit: ch.scene_split.trim() || globalScene,
    imageStyle: ch.image_prompt.trim() || globalImage,
    animationMotion: ch.animation_motion.trim() || globalMotion,
    battleCard: ch.battle_card,
  };
}

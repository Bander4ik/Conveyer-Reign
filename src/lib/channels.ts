import db from "./db";
import { getPrompt } from "./prompts";

/** How a channel's scenes are produced. */
export type VisualSource = "ai" | "science";

export interface Channel {
  id: string;
  name: string;
  scene_split: string;
  image_prompt: string;
  animation_motion: string;
  /** "ai" = generate every scene; "science" = real Wikipedia photos for real subjects, AI otherwise. */
  visual_source: VisualSource;
  /** Add an intro "VS" stat card. Independent of visual_source (works with AI visuals too). */
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
  visualSource: VisualSource;
  battleCard: boolean;
}

const listStmt = db.prepare(
  "SELECT id, name, scene_split, image_prompt, animation_motion, visual_source, battle_card, created_at, updated_at FROM channels ORDER BY name COLLATE NOCASE"
);
const getStmt = db.prepare(
  "SELECT id, name, scene_split, image_prompt, animation_motion, visual_source, battle_card FROM channels WHERE id = ?"
);
const upsertStmt = db.prepare(
  `INSERT INTO channels (id, name, scene_split, image_prompt, animation_motion, visual_source, battle_card, updated_at)
   VALUES (@id, @name, @scene_split, @image_prompt, @animation_motion, @visual_source, @battle_card, datetime('now'))
   ON CONFLICT(id) DO UPDATE SET
     name = excluded.name,
     scene_split = excluded.scene_split,
     image_prompt = excluded.image_prompt,
     animation_motion = excluded.animation_motion,
     visual_source = excluded.visual_source,
     battle_card = excluded.battle_card,
     updated_at = datetime('now')`
);
const deleteStmt = db.prepare("DELETE FROM channels WHERE id = ?");

function normSource(s: unknown): VisualSource {
  return s === "science" ? "science" : "ai";
}
function toBool(v: unknown): boolean {
  return v === 1 || v === "1" || v === true;
}

interface Row {
  id: string;
  name: string;
  scene_split: string;
  image_prompt: string;
  animation_motion: string;
  visual_source: unknown;
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
    visual_source: normSource(r.visual_source),
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
  visual_source?: string;
  battle_card?: boolean | string;
}): void {
  upsertStmt.run({
    id: c.id,
    name: (c.name ?? "").trim() || "Untitled channel",
    scene_split: c.scene_split ?? "",
    image_prompt: c.image_prompt ?? "",
    animation_motion: c.animation_motion ?? "",
    visual_source: normSource(c.visual_source),
    battle_card: toBool(c.battle_card) ? "1" : "0",
  });
}

export function deleteChannel(id: string): void {
  deleteStmt.run(id);
}

/**
 * Resolve the prompts + behavior for a run. A channel's empty prompt fields fall
 * back to the global /prompts defaults. No channel → global prompts, AI visuals,
 * no stat card.
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
      visualSource: "ai",
      battleCard: false,
    };
  }
  return {
    channelId: ch.id,
    channelName: ch.name,
    sceneSplit: ch.scene_split.trim() || globalScene,
    imageStyle: ch.image_prompt.trim() || globalImage,
    animationMotion: ch.animation_motion.trim() || globalMotion,
    visualSource: ch.visual_source,
    battleCard: ch.battle_card,
  };
}

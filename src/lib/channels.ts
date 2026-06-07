import db from "./db";
import { getPrompt } from "./prompts";
import { getSetting } from "./settings";

/** Moving-clip source for scenes that become video. */
export type ClipsSource = "none" | "ai" | "stock";
/** Still-image source for scenes that stay photos. */
export type StillsSource = "ai" | "stock";

export interface Channel {
  id: string;
  name: string;
  scene_split: string;
  image_prompt: string;
  animation_motion: string;
  /** none = all stills; ai = AI Veo clips; stock = real Pexels clips. */
  clips_source: ClipsSource;
  /** % of scenes that become moving clips (the rest are stills). */
  clips_ratio: number;
  /** ai = AI nano-banana images; stock = real Pexels photos. */
  stills_source: StillsSource;
  /** Honor per-scene real_image/person_overlay routing (real Wikipedia photos). */
  real_subjects: boolean;
  /** AI narration on/off. */
  voiceover: boolean;
  /** Keep the ambient audio Veo generates on its clips. */
  keep_clip_audio: boolean;
  /** Intro "VS" stat card. */
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
  clipsSource: ClipsSource;
  clipsRatio: number;
  stillsSource: StillsSource;
  realSubjects: boolean;
  voiceover: boolean;
  keepClipAudio: boolean;
  battleCard: boolean;
}

const listStmt = db.prepare(
  `SELECT id, name, scene_split, image_prompt, animation_motion,
          clips_source, clips_ratio, stills_source, real_subjects, voiceover, keep_clip_audio,
          battle_card, created_at, updated_at
   FROM channels ORDER BY name COLLATE NOCASE`
);
const getStmt = db.prepare(
  `SELECT id, name, scene_split, image_prompt, animation_motion,
          clips_source, clips_ratio, stills_source, real_subjects, voiceover, keep_clip_audio, battle_card
   FROM channels WHERE id = ?`
);
const upsertStmt = db.prepare(
  `INSERT INTO channels
     (id, name, scene_split, image_prompt, animation_motion,
      clips_source, clips_ratio, stills_source, real_subjects, voiceover, keep_clip_audio, battle_card, updated_at)
   VALUES
     (@id, @name, @scene_split, @image_prompt, @animation_motion,
      @clips_source, @clips_ratio, @stills_source, @real_subjects, @voiceover, @keep_clip_audio, @battle_card, datetime('now'))
   ON CONFLICT(id) DO UPDATE SET
     name = excluded.name,
     scene_split = excluded.scene_split,
     image_prompt = excluded.image_prompt,
     animation_motion = excluded.animation_motion,
     clips_source = excluded.clips_source,
     clips_ratio = excluded.clips_ratio,
     stills_source = excluded.stills_source,
     real_subjects = excluded.real_subjects,
     voiceover = excluded.voiceover,
     keep_clip_audio = excluded.keep_clip_audio,
     battle_card = excluded.battle_card,
     updated_at = datetime('now')`
);
const deleteStmt = db.prepare("DELETE FROM channels WHERE id = ?");

function toBool(v: unknown, dflt = false): boolean {
  if (v === 1 || v === "1" || v === true) return true;
  if (v === 0 || v === "0" || v === false) return false;
  return dflt;
}
function normClips(v: unknown): ClipsSource {
  return v === "none" || v === "stock" ? v : "ai";
}
function normStills(v: unknown): StillsSource {
  return v === "stock" ? "stock" : "ai";
}
function toRatio(v: unknown, dflt = 50): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(100, Math.max(0, Math.round(n)));
}

interface Row {
  id: string;
  name: string;
  scene_split: string;
  image_prompt: string;
  animation_motion: string;
  clips_source: unknown;
  clips_ratio: unknown;
  stills_source: unknown;
  real_subjects: unknown;
  voiceover: unknown;
  keep_clip_audio: unknown;
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
    // New columns are NULL on channels that predate them → sensible defaults.
    clips_source: r.clips_source == null ? "ai" : normClips(r.clips_source),
    clips_ratio: r.clips_ratio == null ? 50 : toRatio(r.clips_ratio),
    stills_source: r.stills_source == null ? "ai" : normStills(r.stills_source),
    real_subjects: toBool(r.real_subjects, true),
    voiceover: toBool(r.voiceover, true),
    keep_clip_audio: toBool(r.keep_clip_audio, false),
    battle_card: toBool(r.battle_card, false),
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
  clips_source?: string;
  clips_ratio?: number | string;
  stills_source?: string;
  real_subjects?: boolean | string;
  voiceover?: boolean | string;
  keep_clip_audio?: boolean | string;
  battle_card?: boolean | string;
}): void {
  upsertStmt.run({
    id: c.id,
    name: (c.name ?? "").trim() || "Untitled channel",
    scene_split: c.scene_split ?? "",
    image_prompt: c.image_prompt ?? "",
    animation_motion: c.animation_motion ?? "",
    clips_source: normClips(c.clips_source),
    clips_ratio: String(toRatio(c.clips_ratio)),
    stills_source: normStills(c.stills_source),
    real_subjects: toBool(c.real_subjects, true) ? "1" : "0",
    voiceover: toBool(c.voiceover, true) ? "1" : "0",
    keep_clip_audio: toBool(c.keep_clip_audio, false) ? "1" : "0",
    battle_card: toBool(c.battle_card, false) ? "1" : "0",
  });
}

export function deleteChannel(id: string): void {
  deleteStmt.run(id);
}

/**
 * Resolve prompts + behavior for a run. A channel's empty prompt fields fall
 * back to the global /prompts defaults. With NO channel selected, the whole
 * config is derived from the global Advanced settings, so old runs behave
 * exactly as before.
 */
export function resolveChannel(channelId: string | null | undefined): ResolvedChannel {
  const globalScene = getPrompt("scene_split");
  const globalImage = getPrompt("image_prompt");
  const globalMotion = getPrompt("animation_motion");

  const ch = channelId ? getChannel(channelId) : null;
  if (!ch) {
    const animProvider = (getSetting("ANIMATION_PROVIDER") || "69labs").toLowerCase();
    return {
      channelId: null,
      channelName: null,
      sceneSplit: globalScene,
      imageStyle: globalImage,
      animationMotion: globalMotion,
      clipsSource: animProvider === "off" ? "none" : "ai",
      clipsRatio: toRatio(getSetting("ANIMATION_RATIO_PERCENT"), 50),
      stillsSource: "ai",
      realSubjects: true,
      voiceover: true,
      keepClipAudio: getSetting("ANIMATION_KEEP_VEO_AUDIO") === "1",
      battleCard: false,
    };
  }
  return {
    channelId: ch.id,
    channelName: ch.name,
    sceneSplit: ch.scene_split.trim() || globalScene,
    imageStyle: ch.image_prompt.trim() || globalImage,
    animationMotion: ch.animation_motion.trim() || globalMotion,
    clipsSource: ch.clips_source,
    clipsRatio: ch.clips_ratio,
    stillsSource: ch.stills_source,
    realSubjects: ch.real_subjects,
    voiceover: ch.voiceover,
    keepClipAudio: ch.keep_clip_audio,
    battleCard: ch.battle_card,
  };
}

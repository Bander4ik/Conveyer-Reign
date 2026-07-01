import type { Scene } from "./scene-split";

/**
 * Shot grammar — documentary shot design on top of the scene split.
 *
 * The pipeline otherwise drives EVERY image off one global style string and
 * EVERY clip off one global motion string ("subject centered, gentle camera, do
 * NOT pan/zoom") — so all footage looks the same. This adds a per-scene shot
 * vocabulary so the run reads like an edited documentary, not a slideshow:
 *   - shot_type   → image FRAMING (macro / close / medium / wide / aerial / …)
 *   - camera_move → clip MOTION grammar (push-in / pull-back / track / …)
 *   - emphasis    → editorial intent (climax = hold; reveal = disclosing move)
 *
 * Mirrors the beat-normalizer split of responsibility: the LLM owns the creative
 * intent (it reads the narration and tags each scene in scene-split), and this
 * module is the DETERMINISTIC normalizer that fills gaps, guarantees variety
 * (no slideshow of identical frames), and respects continuity. It is gated by
 * the SHOT_GRAMMAR setting and is fully reversible — when off, no fields are set
 * and every clause below is inert (returns "" / the existing global fallback),
 * so behavior is byte-identical to before.
 *
 * Interaction with continuity (verified against pipeline.ts):
 *   - Motion-chained followers SKIP image generation (they animate from the
 *     predecessor's last frame), so shot_type framing only ever renders for
 *     anchors / chain-heads — exactly where framing variety belongs.
 *   - camera_move applies to EVERY clip, so it carries the variation WITHIN a
 *     continuous shot. That is why framing and move are separate fields.
 */

export type ShotType =
  | "establishing"
  | "wide"
  | "medium"
  | "close"
  | "macro"
  | "aerial"
  | "insert"
  | "over_shoulder";

export type CameraMove =
  | "static"
  | "slow_push"
  | "pull_back"
  | "track"
  | "pan"
  | "tilt"
  | "drift";

export type Emphasis = "normal" | "emphasis" | "climax" | "reveal";

export const SHOT_TYPES: ReadonlySet<string> = new Set<ShotType>([
  "establishing",
  "wide",
  "medium",
  "close",
  "macro",
  "aerial",
  "insert",
  "over_shoulder",
]);

export const CAMERA_MOVES: ReadonlySet<string> = new Set<CameraMove>([
  "static",
  "slow_push",
  "pull_back",
  "track",
  "pan",
  "tilt",
  "drift",
]);

export const EMPHASES: ReadonlySet<string> = new Set<Emphasis>([
  "normal",
  "emphasis",
  "climax",
  "reveal",
]);

/**
 * Image-prompt framing clause, slotted in BEFORE the global style suffix. Each
 * ends with ", " so it concatenates cleanly. Returns "" when no shot_type, so
 * the final prompt is unchanged when shot grammar is off.
 */
export function shotTypeClause(shot?: string): string {
  switch (shot) {
    case "establishing":
      return "wide establishing shot, the subject small within a vast landscape, deep focus, strong sense of place, ";
    case "wide":
      return "wide shot, the full body of the subject within its environment with generous context, ";
    case "medium":
      return "medium shot, the subject filling the middle of the frame from a natural distance, ";
    case "close":
      return "close-up shot, tight on the subject's head and face, shallow depth of field, eyes sharp, ";
    case "macro":
      return "extreme macro detail shot, tight on texture — fur, claws, eyes, dust — razor-shallow depth of field, ";
    case "aerial":
      return "high aerial drone shot looking down, the subject and landscape seen from above, ";
    case "insert":
      return "tight insert cutaway, isolating one significant detail of the scene, shallow depth of field, ";
    case "over_shoulder":
      return "over-the-shoulder framing from just behind the near animal, looking past its shoulder toward the other subject across the scene, both subjects kept in frame, ";
    default:
      return "";
  }
}

// The subject-safety rail kept on EVERY per-move clause: it preserves the
// original global motion's guarantee that Veo never drifts off the subject into
// an empty background (the failure mode the single global string guarded).
const IN_FRAME_RAIL =
  "keep the main subject in frame for the whole clip, natural lifelike motion, photographic realism, no cartoon stylization, no jarring cuts";

/**
 * Clip-motion clause. When camera_move is set, returns a move-specific sentence
 * that still carries the in-frame safety rail. When absent, returns `fallback`
 * unchanged (the channel/global animation_motion) — so motion is byte-identical
 * to before when shot grammar is off.
 */
export function cameraMoveClause(move: string | undefined, fallback: string): string {
  let lead: string;
  switch (move) {
    case "static":
      lead = "the camera holds steady, only the subject itself moves naturally";
      break;
    case "slow_push":
      lead = "a slow cinematic push-in gradually moving closer to the subject";
      break;
    case "pull_back":
      lead = "a slow cinematic pull-back gradually revealing more of the surrounding scene";
      break;
    case "track":
      lead = "a smooth tracking shot following the subject's movement";
      break;
    case "pan":
      lead = "a slow controlled pan across the scene";
      break;
    case "tilt":
      lead = "a slow vertical tilt across the subject and its setting";
      break;
    case "drift":
      lead = "a gentle aerial drift over the landscape";
      break;
    default:
      return fallback;
  }
  return `${lead}; ${IN_FRAME_RAIL}`;
}

/** Per-shot-type default camera moves used to fill gaps with sane, varied
 *  motion (never picks something that fights the framing — e.g. a macro never
 *  tracks). The normalizer rotates within each list to avoid repetition. */
const MOVE_BY_SHOT: Record<ShotType, CameraMove[]> = {
  establishing: ["slow_push", "pull_back", "static"],
  wide: ["pull_back", "pan", "slow_push"],
  medium: ["track", "slow_push", "static"],
  close: ["slow_push", "static"],
  macro: ["slow_push", "static"],
  aerial: ["drift", "pan"],
  insert: ["slow_push", "static"],
  over_shoulder: ["slow_push", "static"],
};

/** Position-in-shot framing ladder for deterministic gap-fill: a shot opens
 *  wide for orientation, then tightens. over_shoulder/aerial/insert are NEVER
 *  auto-assigned — they need narration context only the LLM has. */
const FRAMING_LADDER: ShotType[] = ["wide", "medium", "close", "macro", "medium", "close"];

/**
 * Deterministically complete + harmonize the LLM's shot tags in place.
 *  1. Fill missing shot_type by position within its shot (establishing head →
 *     tightening ladder). Respects `new_shot` to know where shots begin.
 *  2. Break monotony: any run of ≥3 identical shot_types (none emphasis-pinned)
 *     gets its middle nudged to an adjacent framing.
 *  3. Fill missing camera_move from emphasis first (climax = hold, reveal =
 *     disclosing move, emphasis = lean-in), else a varied per-framing default.
 *
 * Returns the same array (mutated) for convenient chaining + logging.
 */
export function assignShotGrammar(scenes: Scene[]): Scene[] {
  // ── Pass 1: fill shot_type by position within each shot ──────────────────
  let posInShot = 0;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const isHead = i === 0 || s.new_shot === true;
    if (isHead) posInShot = 0;
    if (!s.shot_type) {
      // The very first scene of the whole video opens on an establishing wide;
      // every other shot head opens "wide"; followers tighten down the ladder.
      if (isHead) s.shot_type = i === 0 ? "establishing" : "wide";
      else s.shot_type = FRAMING_LADDER[Math.min(posInShot, FRAMING_LADDER.length - 1)];
    }
    posInShot++;
  }

  // ── Pass 2: anti-monotony — no 3 identical framings in a row ─────────────
  // Skip emphasis-pinned scenes (a climax/reveal framing is intentional). Only
  // nudges the MIDDLE of a run so heads/anchors keep their deliberate framing.
  const NUDGE: Record<string, ShotType> = {
    establishing: "wide",
    wide: "medium",
    medium: "close",
    close: "medium",
    macro: "close",
    aerial: "wide",
    insert: "close",
    over_shoulder: "medium",
  };
  for (let i = 1; i < scenes.length - 1; i++) {
    const a = scenes[i - 1].shot_type;
    const b = scenes[i].shot_type;
    const c = scenes[i + 1].shot_type;
    const pinned = scenes[i].emphasis === "climax" || scenes[i].emphasis === "reveal";
    if (!pinned && a && a === b && b === c) {
      scenes[i].shot_type = NUDGE[b] ?? "medium";
    }
  }

  // ── Pass 3: fill camera_move (emphasis-driven, else varied per framing) ───
  // Track the last move so per-framing defaults rotate instead of repeating.
  const moveCursor: Partial<Record<ShotType, number>> = {};
  let lastMove: CameraMove | undefined;
  for (const s of scenes) {
    if (s.camera_move) {
      lastMove = s.camera_move as CameraMove;
      continue;
    }
    const shot = (s.shot_type ?? "medium") as ShotType;
    let move: CameraMove;
    if (s.emphasis === "climax") {
      // Peak action — hold on it.
      move = "static";
    } else if (s.emphasis === "reveal") {
      // Disclosure — MOVE to reveal: pull back from open framings, push into tight ones.
      move = shot === "wide" || shot === "establishing" || shot === "aerial" ? "pull_back" : "slow_push";
    } else if (s.emphasis === "emphasis") {
      move = "slow_push";
    } else {
      // Rotate within this framing's safe moves, avoiding an immediate repeat.
      const opts = MOVE_BY_SHOT[shot] ?? MOVE_BY_SHOT.medium;
      let k = moveCursor[shot] ?? 0;
      move = opts[k % opts.length];
      if (move === lastMove && opts.length > 1) move = opts[(k + 1) % opts.length];
      moveCursor[shot] = k + 1;
    }
    s.camera_move = move;
    lastMove = move;
  }

  return scenes;
}

/** Compact histogram for the run log, e.g. "establishing 2 · wide 3 · medium 5". */
export function shotTypeHistogram(scenes: Scene[]): string {
  const counts = new Map<string, number>();
  for (const s of scenes) {
    const t = s.shot_type ?? "—";
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].map(([t, n]) => `${t} ${n}`).join(" · ");
}

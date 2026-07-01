import type { Scene } from "./scene-split";

/**
 * Deterministic, timing-driven beat sizing — transplanted from Conveyer-VIP's
 * `buildBeats` (studio-plan.ts). Reign is AI-only, so we DON'T retrieve footage;
 * we reuse only VIP's source-agnostic "fold a word timeline into evenly-sized
 * beats" engine to fix prompt-driven beat sizing (bimodal beats → frozen Veo
 * tails / slideshow cuts).
 *
 * The LLM scene-split still owns SEMANTICS (visual_prompt, characters[],
 * new_shot, visual_type/routing). This module only re-SIZES the scenes it
 * produced so no beat runs past Veo's ~8 s of real motion, while preserving the
 * verbatim-coverage invariant (concatenated text is unchanged — only boundaries
 * move). Over-long scenes are subdivided into chained sub-beats (continuations
 * tagged new_shot:false) so the existing motion-chaining stitches them into ONE
 * continuous flowing shot rather than a hard cut.
 *
 * `buildBeats` (and SENTENCE_END / CLAUSE_BREAK / BEAT_CONNECTIVES /
 * endsOnConnective) below are copied byte-for-byte from VIP and must stay that
 * way — keep them independently testable and trivially upgradable to REAL word
 * timings (single-shot Whisper) later. Reign feeds them SYNTHETIC timings
 * derived from scene text at a calibrated words/sec rate (see
 * scriptToSyntheticWords) — no real audio exists at scene-split time.
 */

/** Minimal word-timing token — matches VIP's WordTiming and Reign's
 *  TranscriptWord (tts-align.ts) shape so a real-timing upgrade is a drop-in. */
export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

/** Partial beat emitted by buildBeats (VIP's Beat without the footage fields). */
export interface SizedBeat {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

// ─── VERBATIM FROM CONVEYER-VIP (studio-plan.ts) — DO NOT EDIT ───────────────
const SENTENCE_END = /[.!?]["')\]]?$/;
const CLAUSE_BREAK = /[,;:—–]["')\]]?$/;
// Connective tokens a beat must NOT end on — flushing here yields fragments like
// "turning into" / "hiding in". When the boundary token is one of these, the
// flush is deferred until a better (non-connective) boundary.
const BEAT_CONNECTIVES = new Set(["into", "and", "or", "that", "the", "a", "an", "of", "to", "in", "on"]);
const endsOnConnective = (token: string): boolean =>
  BEAT_CONNECTIVES.has(token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));

/**
 * Fold words into beats of ~targetSec, breaking at natural pauses.
 *
 * Beats vary between minSec and maxSec (defaults 3–10 s) instead of all hitting
 * the hard cap:
 *  - a sentence end closes the beat once it's past ~max(min, 55% of target);
 *  - a clause break (comma, colon…) closes it once it's ~15% past target —
 *    long sentences used to ride to the cap, making every beat the same length;
 *  - maxSec is the hard cap (mid-sentence cut as a last resort).
 */
export function buildBeats(
  words: WordTiming[],
  targetSec: number,
  minSec = 3,
  maxSec = 10
): SizedBeat[] {
  const target = Math.max(1.5, targetSec) * 1000;
  const minMs = Math.max(1000, Math.min(minSec, targetSec) * 1000);
  const maxMs = Math.max(target * 1.15, maxSec * 1000);
  const sentenceFloor = Math.max(minMs, target * 0.55);
  const beats: SizedBeat[] = [];
  let cur: WordTiming[] = [];
  let startMs = words[0]?.startMs ?? 0;

  const flush = () => {
    if (cur.length === 0) return;
    beats.push({
      index: beats.length,
      startMs,
      endMs: cur[cur.length - 1].endMs,
      text: cur.map((w) => w.word).join(" "),
    });
    cur = [];
  };

  for (const w of words) {
    if (cur.length === 0) startMs = w.startMs;
    cur.push(w);
    const dur = w.endMs - startMs;
    const wantFlush =
      (SENTENCE_END.test(w.word) && dur >= sentenceFloor) ||
      (CLAUSE_BREAK.test(w.word) && dur >= target * 1.15) ||
      dur >= maxMs;
    // FIX B: never end a beat on a connective token — keep accumulating to a
    // better boundary (applies to sentence, clause, AND hard-cap flushes).
    if (wantFlush && !endsOnConnective(w.word)) {
      flush();
    }
  }
  flush();

  // FIX A: merge a too-small trailing beat (e.g. "three-pound") into the previous
  // one — the final flush above is unconditional and can emit a weak tail beat.
  if (beats.length >= 2) {
    const last = beats[beats.length - 1];
    const lastWords = last.text.trim().split(/\s+/).filter(Boolean).length;
    if (last.endMs - last.startMs < minMs || lastWords <= 2) {
      const prev = beats[beats.length - 2];
      prev.text += " " + last.text;
      prev.endMs = last.endMs;
      beats.pop();
    }
  }
  return beats;
}
// ─── END VERBATIM ────────────────────────────────────────────────────────────

/**
 * Reign adapter: turn a scene's text into a synthetic word timeline at a fixed
 * narration rate. buildBeats inspects only each token's trailing punctuation
 * (SENTENCE_END / CLAUSE_BREAK) and the word string (connective guard), and
 * whitespace tokenization keeps punctuation attached — so synthetic timings
 * drive the exact same boundary logic as real audio, just estimated.
 */
export function scriptToSyntheticWords(text: string, wordsPerSec: number): WordTiming[] {
  const toks = text.split(/\s+/).filter(Boolean);
  const msPerWord = 1000 / Math.max(0.5, wordsPerSec);
  let t = 0;
  return toks.map((w) => {
    const startMs = t;
    t += msPerWord;
    return { word: w, startMs, endMs: t };
  });
}

export interface NormalizeOpts {
  targetSec: number;
  minSec: number;
  maxSec: number;
  /** Narration rate used to estimate scene seconds (measured ≈ 2.63 w/s). */
  wordsPerSec: number;
}

/** Estimated seconds for a slice of text at the given narration rate. */
function estSeconds(text: string, wordsPerSec: number): number {
  const n = text.split(/\s+/).filter(Boolean).length;
  return n / Math.max(0.5, wordsPerSec);
}

/**
 * Deterministically re-size LLM scenes for Veo-safe pacing, preserving every
 * continuity field. Two passes, then re-index:
 *  1. SPLIT any scene estimated longer than maxSec into chained sub-beats
 *     (buildBeats over synthetic timings). Sub-scenes inherit all semantics;
 *     the first keeps the parent's new_shot, continuations get new_shot:false
 *     so motion-chaining stitches them into one continuous shot.
 *  2. MERGE whole-scene runts (< minSec) into the previous SAME-shot neighbor
 *     (never across a new_shot:true boundary). buildBeats already handles
 *     within-scene trailing runts; this handles runts the LLM emitted directly.
 * Verbatim coverage is preserved — only boundaries move; every token is kept.
 */
export function normalizeScenes(scenes: Scene[], opts: NormalizeOpts): Scene[] {
  const { targetSec, minSec, maxSec, wordsPerSec } = opts;

  // ── Pass 1: split over-long scenes ──────────────────────────────────────
  const split: Scene[] = [];
  for (const scene of scenes) {
    // Leave correctly-sized scenes byte-identical (no re-cut, no whitespace
    // churn). Only the long ones get subdivided.
    if (estSeconds(scene.text, wordsPerSec) <= maxSec) {
      split.push(scene);
      continue;
    }
    const words = scriptToSyntheticWords(scene.text, wordsPerSec);
    const beats = buildBeats(words, targetSec, minSec, maxSec);
    if (beats.length <= 1) {
      // buildBeats collapsed it back (e.g. a single long clause-free sentence
      // whose remainder was a runt) — keep the scene; the assembler's
      // stretch+freeze covers the small residual tail.
      split.push(scene);
      continue;
    }
    beats.forEach((b, i) => {
      split.push({
        ...scene,
        text: b.text,
        duration_hint_sec: Math.max(1, Math.round((b.endMs - b.startMs) / 1000)),
        new_shot: i === 0 ? scene.new_shot : false,
      });
    });
  }

  // ── Pass 2: merge whole-scene runts into the previous same-shot neighbor ──
  const merged: Scene[] = [];
  for (const scene of split) {
    const prev = merged[merged.length - 1];
    const isRunt = estSeconds(scene.text, wordsPerSec) < minSec;
    // A scene that STARTS a shot (new_shot) is never folded backward — it's the
    // shot's intended head. A runt continuation folds into its shot neighbor.
    if (isRunt && prev && !scene.new_shot) {
      prev.text = `${prev.text} ${scene.text}`.trim();
      prev.duration_hint_sec = Math.max(1, Math.round(estSeconds(prev.text, wordsPerSec)));
      const chars = new Set([...(prev.characters ?? []), ...(scene.characters ?? [])]);
      if (chars.size) prev.characters = [...chars];
      continue;
    }
    merged.push({ ...scene });
  }

  // ── Re-index 0..N ───────────────────────────────────────────────────────
  merged.forEach((s, i) => {
    s.index = i;
  });
  return merged;
}

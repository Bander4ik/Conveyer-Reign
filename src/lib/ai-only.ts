import { log } from "./logger";

/**
 * HARD ARCHITECTURAL CONSTRAINT — Conveyer Reign is a 100% AI-only documentary
 * generator. EVERY visual must be AI-generated (image-gen → img2vid). It is
 * architecturally forbidden for ANY external media to enter the pipeline:
 * Wikimedia, Openverse, Pexels, Pixabay, Internet Archive, YouTube, stock
 * footage, or real person overlays.
 *
 * This is a COMPILE-TIME constant, NOT a user setting — by product design it
 * must never be togglable from the UI/DB. Enforcement is layered:
 *   - Layer 1 (primary guarantee): the scene-split sanitizer strips every
 *     real-media routing field the LLM may emit (visual_type→"generated",
 *     real_image_query / wikipedia_lookup / person_name cleared), so no scene
 *     can ever request real media.
 *   - Layer 2: the scene-split LLM is never even shown the real-media routing
 *     instruction (buildRoutingSuffix is omitted).
 *   - Layer 3: `assertAiOnly()` is a fail-fast tripwire planted at the two
 *     external-media GATEWAYS (tryRealImage, acquireScoredFootage). If Layer 1
 *     ever regresses and one is reached, it logs a loud error AND throws —
 *     making the violation VISIBLE instead of silently fetching real media.
 *
 * The `: boolean` annotation (rather than the literal `true`) keeps the guarded
 * conditionals from being flagged as dead code while remaining a constant.
 */
export const AI_ONLY_MODE: boolean = true;

/**
 * Tripwire for external-media code paths. Under AI-only, reaching one of these
 * is a BUG (the scene-split sanitizer should have made it unreachable), so we
 * fail CLOSED: log a loud error (so it's visible even if a caller swallows the
 * throw) and then throw, rather than fetch external media. Do NOT catch-and-
 * ignore this — fix the routing that let a scene reach the gateway.
 */
export function assertAiOnly(context: string, runId?: string): void {
  if (!AI_ONLY_MODE) return;
  const msg =
    `AI_ONLY violation: an external-media path was reached (${context}). ` +
    `Conveyer Reign is AI-only — Wikimedia / Openverse / Pexels / Pixabay / ` +
    `Internet Archive / stock footage / real person overlays must never be fetched. ` +
    `A scene escaped the AI-only sanitizer in scene-split; fix the routing, do NOT disable this guard.`;
  if (runId) log(runId, "error", msg, { stage: "ai_only" });
  throw new Error(msg);
}

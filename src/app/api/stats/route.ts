import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getSetting } from "@/lib/settings";
import { getKeyCount } from "@/lib/services/labs69";

/**
 * Returns runtime stats used by the UI for estimate widgets:
 *   - how many 69labs keys are configured
 *   - effective per-key + total concurrency for each stage
 *   - animation distribution settings
 *
 * Does NOT expose key values themselves — only the count.
 */
export async function GET() {
  ensureInit();
  const keyCount = getKeyCount();
  const imageConcurrencyPerKey = Math.max(1, Number(getSetting("IMAGE_CONCURRENCY") || "5"));
  const ttsConcurrencyPerKey = Math.max(1, Number(getSetting("TTS_CONCURRENCY") || "3"));
  const animConcurrencyPerKey = Math.max(1, Number(getSetting("ANIMATION_CONCURRENCY") || "3"));
  const assembleConcurrency = Math.max(1, Number(getSetting("ASSEMBLE_CONCURRENCY") || "4"));
  const xfadeChunks = Math.max(1, Number(getSetting("ASSEMBLE_XFADE_CHUNKS") || "4"));
  const animationProvider = (getSetting("ANIMATION_PROVIDER") || "off").toLowerCase();
  const animationRatio = Math.max(0, Math.min(100, Number(getSetting("ANIMATION_RATIO_PERCENT") || "50")));

  return NextResponse.json({
    keyCount,
    perKey: {
      image: imageConcurrencyPerKey,
      tts: ttsConcurrencyPerKey,
      anim: animConcurrencyPerKey,
    },
    total: {
      image: imageConcurrencyPerKey * Math.max(1, keyCount),
      tts: ttsConcurrencyPerKey * Math.max(1, keyCount),
      anim: animConcurrencyPerKey * Math.max(1, keyCount),
    },
    assembleConcurrency,
    xfadeChunks,
    animationEnabled: animationProvider !== "off",
    animationRatio,
  });
}

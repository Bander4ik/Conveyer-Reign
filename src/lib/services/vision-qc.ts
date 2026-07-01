import fs from "node:fs";
import { getSetting, geminiModel } from "../settings";
import { log } from "../logger";

/**
 * Vision QC gate — closes the open loop in AI image generation.
 *
 * The pipeline otherwise generates an image from a prompt and HOPES it shows the
 * right thing; nothing inspects the output, and a wrong anchor frame (e.g. a bear
 * where the script said "leopard cub") propagates across the whole shot. This
 * asks a Gemini vision model to look at the freshly-generated frame and rate it
 * on TWO axes — subject correctness and cinematic quality — which the caller
 * combines hierarchically (subject is a hard floor; cinema is weighted-secondary).
 *
 * Reuses the same Gemini-vision call pattern as the (now-dormant) footage scorer
 * in visual-source.ts: GOOGLE_API_KEY + VISION_MATCH_MODEL || geminiModel()
 * (flash — cheap/fast), the local PNG sent as base64 inline_data, strict-JSON out.
 *
 * FAIL-OPEN: any error (no key, model down, parse failure, timeout) returns
 * available=false with full scores, and logs `[qc] QC unavailable — fail-open`,
 * so a degraded QC accepts the frame but is never mistaken for a clean pass.
 */

export interface FrameScores {
  /** 0-100 — is this EXACTLY the intended subject (species + life-stage precise)? */
  subjectScore: number;
  /** 0-100 — documentary cinematography quality (composition / light / depth / dynamism). */
  cinemaScore: number;
  reason: string;
  /** false when QC could not run (fail-open); scores are sentinel 100/100. */
  available: boolean;
}

export interface QcInput {
  /** Scene narration (context for what the frame should depict). */
  sceneText: string;
  /** The image-generation prompt (carries the intended species/subject). */
  visualPrompt: string;
  /** Tagged recurring subjects for this scene, if any (e.g. "Leopard cub"). */
  subjects: string[];
}

const QC_TIMEOUT_MS = 15_000;

/**
 * Rate `imagePath` on subject correctness + cinematic quality. The subject axis
 * is species- and life-stage-PRECISE (a cub is not an adult; a leopard is not a
 * cheetah or a bear) with continuous anchored bands, so a mid-range floor is
 * meaningful. The caller owns the accept/regen decision.
 */
export async function verifyFrame(
  runId: string,
  imagePath: string,
  input: QcInput
): Promise<FrameScores> {
  // FAIL-OPEN: accept (available=false) but make it VISIBLE in the run log.
  const failOpen = (reason: string): FrameScores => {
    log(runId, "warn", `QC unavailable — fail-open (${reason})`, { stage: "qc" });
    return { subjectScore: 100, cinemaScore: 100, reason: `qc unavailable (${reason})`, available: false };
  };

  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) return failOpen("no GOOGLE_API_KEY");

  let data: string;
  try {
    data = fs.readFileSync(imagePath).toString("base64");
  } catch (e) {
    return failOpen(`read: ${(e as Error).message.slice(0, 60)}`);
  }

  const intended =
    (input.subjects.length ? `${input.subjects.join(", ")}. ` : "") + input.visualPrompt.slice(0, 400);
  const prompt =
    `You are a STRICT QC reviewer for an AI-generated wildlife DOCUMENTARY frame.\n` +
    `INTENDED MAIN SUBJECT: "${intended}"\n` +
    `NARRATION (context): "${input.sceneText.slice(0, 200)}"\n\n` +
    `Judge ONLY the image, on TWO axes, each an integer 0-100:\n\n` +
    `1) subjectScore — is this EXACTLY the intended subject? Be species- and life-stage-PRECISE: ` +
    `the correct species (not a lookalike) AND the correct age/sex/markings if specified ` +
    `(a leopard CUB is NOT an adult leopard; a leopard is NOT a cheetah, jaguar, or bear).\n` +
    `   0-40  = wrong species/subject, OR severe anatomical deformation (extra/missing limbs, melted face or eyes).\n` +
    `   41-60 = right general animal but a NOTABLE mismatch (wrong age/sex, wrong markings, doubtful identity, partial deformation, or visible text/watermark).\n` +
    `   61-100 = correct subject with solid, believable identity (higher = cleaner, no defects).\n\n` +
    `2) cinemaScore — documentary cinematography quality: composition, natural directional lighting, ` +
    `depth / foreground separation, and DYNAMISM (a mid-action, alive frame vs a flat, dead-center static pose). ` +
    `0 = flat amateur snapshot or CGI/cartoon look; 100 = premium BBC/NatGeo photoreal frame with depth and life.\n\n` +
    `Return STRICTLY JSON: {"subjectScore": <int>, "cinemaScore": <int>, "reason": "<short; note any subject mismatch FIRST>"}. No markdown.`;

  const model = getSetting("VISION_MATCH_MODEL") || geminiModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), QC_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }, { inline_data: { mime_type: "image/png", data } }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0,
          maxOutputTokens: 500,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!r.ok) return failOpen(`gemini ${r.status}`);
    const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? text) as {
      subjectScore?: number;
      cinemaScore?: number;
      reason?: string;
    };
    const subjectScore = Number(parsed.subjectScore);
    const cinemaScore = Number(parsed.cinemaScore);
    if (!Number.isFinite(subjectScore) || !Number.isFinite(cinemaScore)) {
      return failOpen("no scores in response");
    }
    return {
      subjectScore,
      cinemaScore,
      reason: String(parsed.reason ?? "").slice(0, 140),
      available: true,
    };
  } catch (e) {
    return failOpen((e as Error).message.slice(0, 60));
  } finally {
    clearTimeout(t);
  }
}

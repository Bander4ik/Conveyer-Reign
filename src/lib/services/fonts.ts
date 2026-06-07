import fs from "node:fs";
import path from "node:path";

let cachedRef: string | null = null;

function candidates(): string[] {
  if (process.platform === "win32") {
    return ["C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf"];
  }
  if (process.platform === "darwin") {
    return [
      "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
      "/System/Library/Fonts/Supplemental/Arial.ttf",
      "/Library/Fonts/Arial.ttf",
    ];
  }
  return [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ];
}

/**
 * A drawtext-safe font reference for ffmpeg.
 *
 * ffmpeg's filtergraph parser treats `:` as an option separator, so a Windows
 * absolute path (`C:/Windows/Fonts/...`) breaks `drawtext=fontfile=...` — and
 * escaping the colon proved unreliable across ffmpeg builds (verified: it fails
 * on Windows). So we copy a system font into a **cwd-relative** cache and hand
 * back a colon-free relative path (forward slashes). ffmpeg runs with the same
 * cwd as the Node process, so the relative path resolves correctly.
 *
 * Returns "" if no usable font is found — callers then skip the text overlay.
 */
export function drawtextFont(): string {
  if (cachedRef && fs.existsSync(cachedRef)) return cachedRef;
  try {
    const src = candidates().find((p) => fs.existsSync(p));
    if (!src) return "";
    const dir = ".cache-fonts";
    const dest = path.join(dir, "label.ttf");
    // Copy via a temp name + atomic rename so a crash mid-copy never leaves a
    // truncated label.ttf that would silently break every drawtext afterwards.
    if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${dest}.tmp`;
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dest);
    }
    cachedRef = dest.split(path.sep).join("/");
    return cachedRef;
  } catch {
    return "";
  }
}

/** Strip characters that have meaning inside an ffmpeg drawtext filtergraph. */
export function escDrawtext(s: string, max = 48): string {
  return s
    .replace(/[\\:'%,\[\];=]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

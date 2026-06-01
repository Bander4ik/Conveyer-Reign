import fs from "node:fs";
import path from "node:path";

/**
 * Upload a local image to a public host so 69labs can fetch it as a reference.
 *
 * 69labs `/images/generate` accepts `imageUrls` as public http(s) URLs ONLY
 * (the OpenAPI marks them `format: uri`; there is no upload endpoint and base64
 * data URIs are not accepted). So a character reference image — whether the
 * user uploaded it or we generated it — has to live at a reachable URL first.
 *
 * We use litterbox (catbox's *temporary* host) with a 72h expiry: references
 * are only needed for the few minutes a run takes, and auto-expiry means we
 * don't accumulate uploaded faces on a permanent public host.
 */
const LITTERBOX_API = "https://litterbox.catbox.moe/resources/internals/api.php";
const UPLOAD_TIMEOUT_MS = 60_000;

export async function uploadPublicImage(localPath: string): Promise<string> {
  if (!fs.existsSync(localPath)) throw new Error(`reference image not found: ${localPath}`);
  const buf = fs.readFileSync(localPath);
  const name = path.basename(localPath) || "ref.png";

  const fd = new FormData();
  fd.append("reqtype", "fileupload");
  fd.append("time", "72h");
  fd.append("fileToUpload", new Blob([buf]), name);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const r = await fetch(LITTERBOX_API, { method: "POST", body: fd, signal: ctrl.signal });
    const text = (await r.text()).trim();
    if (!r.ok || !/^https?:\/\//i.test(text)) {
      throw new Error(`litterbox upload failed (${r.status}): ${text.slice(0, 160)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

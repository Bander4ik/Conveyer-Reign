import fs from "node:fs";

/**
 * Tiny media synthesizers that DON'T need ffmpeg's `lavfi` input device.
 *
 * Several ffmpeg builds ship the filter framework (drawtext, zoompan, pad all
 * work) but omit the `lavfi` *input device* — so `-f lavfi -i anullsrc` and
 * `-f lavfi -i color=...` fail with "Input format lavfi is not available".
 * That silently killed the stat card and every silent/no-voiceover track.
 *
 * Writing the silence (WAV) and the solid card background (BMP) directly as
 * files removes the lavfi dependency entirely, so they work on ANY ffmpeg.
 */

/** Write a silent 16-bit PCM WAV (44.1 kHz stereo) of `durationSec`.
 *  Used as a normal `-i` input; downstream always re-encodes the audio, so the
 *  WAV container is fine even when the output file keeps an .mp3 name. */
export function writeSilentWav(outPath: string, durationSec: number): void {
  const sampleRate = 44100;
  const channels = 2;
  const bytesPerSample = 2; // s16
  const frames = Math.max(1, Math.round(Math.max(0.1, durationSec) * sampleRate));
  const dataSize = frames * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize); // 44-byte header + zeroed samples (silence)

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audio format = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(channels * bytesPerSample, 32); // block align
  buf.writeUInt16LE(bytesPerSample * 8, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  // sample bytes are already 0 → silence

  fs.writeFileSync(outPath, buf);
}

/** Write a solid-color 24-bit BMP (`w`×`h`). `hex` accepts "0xRRGGBB",
 *  "#RRGGBB" or "RRGGBB". Used as the stat-card background instead of a
 *  `-f lavfi -i color=` source. */
export function writeSolidBmp(outPath: string, w: number, h: number, hex: string): void {
  const match = hex.trim().match(/^(?:0x|#)?([0-9a-fA-F]{6})$/);
  const rgb = match ? match[1] : "0e0f13";
  const r = parseInt(rgb.slice(0, 2), 16);
  const g = parseInt(rgb.slice(2, 4), 16);
  const b = parseInt(rgb.slice(4, 6), 16);

  const rowBytes = w * 3;
  const pad = (4 - (rowBytes % 4)) % 4; // BMP rows are padded to 4 bytes
  const stride = rowBytes + pad;
  const dataSize = stride * h;
  const fileSize = 54 + dataSize;
  const buf = Buffer.alloc(fileSize);

  // BITMAPFILEHEADER (14 bytes)
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6); // reserved
  buf.writeUInt32LE(54, 10); // pixel data offset

  // BITMAPINFOHEADER (40 bytes)
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22); // positive height = bottom-up rows
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bits per pixel
  buf.writeUInt32LE(0, 30); // BI_RGB (no compression)
  buf.writeUInt32LE(dataSize, 34);
  buf.writeInt32LE(2835, 38); // ~72 DPI (x)
  buf.writeInt32LE(2835, 42); // ~72 DPI (y)
  buf.writeUInt32LE(0, 46); // colors used
  buf.writeUInt32LE(0, 50); // important colors

  // Pixels in BGR order; every pixel is identical so padding bytes stay zero.
  let off = 54;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      buf[off++] = b;
      buf[off++] = g;
      buf[off++] = r;
    }
    off += pad;
  }

  fs.writeFileSync(outPath, buf);
}

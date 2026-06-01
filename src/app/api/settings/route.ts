import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { SETTING_KEYS, getMaskedSettings, getAllSettings, getSetting, setSetting, type SettingKey } from "@/lib/settings";
import { applyRunsRoot } from "@/lib/run-paths";

export async function GET(req: Request) {
  ensureInit();
  const url = new URL(req.url);
  if (url.searchParams.get("reveal") === "1") {
    return NextResponse.json(getAllSettings());
  }
  return NextResponse.json(getMaskedSettings());
}

export async function POST(req: Request) {
  ensureInit();
  const body = (await req.json()) as Record<string, string>;
  const allowed = new Set<string>(SETTING_KEYS);

  // Перевірка зміни RUNS_OUTPUT_DIR ще ДО запису в БД — якщо валідація провалиться,
  // не міняємо інші поля частково.
  if ("RUNS_OUTPUT_DIR" in body) {
    const oldVal = getSetting("RUNS_OUTPUT_DIR");
    const newVal = String(body.RUNS_OUTPUT_DIR ?? "").trim();
    if (newVal !== oldVal) {
      const res = applyRunsRoot(newVal);
      if (!res.ok) {
        return NextResponse.json({ error: `RUNS_OUTPUT_DIR: ${res.error}` }, { status: 400 });
      }
    }
  }

  for (const [k, v] of Object.entries(body)) {
    if (!allowed.has(k)) continue;
    const next = String(v ?? "");

    // Defense against the "save masked secrets" trap:
    // GET returns secret values as "AIza…XXXX" (truncated with U+2026). If the
    // user opens /settings (where they see masked values), doesn't touch the
    // field, and clicks "Save all", the form would POST those masked strings
    // BACK to us — overwriting the real key in the DB with a broken value.
    // The corrupted key then breaks every API call ("Cannot convert argument
    // to a ByteString because the character at index N has a value of 8230").
    const isSecretField = k.includes("KEY") || k.includes("TOKEN") || k.includes("SECRET");
    if (isSecretField && next.includes("…")) {
      continue; // keep existing DB value untouched
    }

    setSetting(k as SettingKey, next);
  }
  return NextResponse.json({ ok: true });
}

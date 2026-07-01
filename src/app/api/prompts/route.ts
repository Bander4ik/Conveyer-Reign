import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import {
  PROMPT_NAMES,
  getAllPrompts,
  setPrompt,
  resetPromptsToDefaults,
  type PromptName,
} from "@/lib/prompts";

export async function GET() {
  ensureInit();
  return NextResponse.json(getAllPrompts());
}

export async function POST(req: Request) {
  ensureInit();
  const body = (await req.json()) as Record<string, string> & { reset?: boolean };

  // Reset-to-defaults: restore every prompt to its factory default and return
  // the new values so the UI can repopulate without a separate GET.
  if (body.reset) {
    resetPromptsToDefaults();
    return NextResponse.json({ ok: true, prompts: getAllPrompts() });
  }

  const allowed = new Set<string>(PROMPT_NAMES);
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.has(k)) continue;
    setPrompt(k as PromptName, String(v ?? ""));
  }
  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { ensureInit } from "@/lib/init";
import { listChannels, upsertChannel, deleteChannel } from "@/lib/channels";

export async function GET() {
  ensureInit();
  return NextResponse.json(listChannels());
}

export async function POST(req: Request) {
  ensureInit();
  const body = (await req.json()) as {
    id?: string;
    name?: string;
    scene_split?: string;
    image_prompt?: string;
    animation_motion?: string;
    clips_source?: string;
    clips_ratio?: number | string;
    stills_source?: string;
    real_subjects?: boolean | string;
    voiceover?: boolean | string;
    keep_clip_audio?: boolean | string;
    battle_card?: boolean | string;
    voice_id?: string;
    thumbnail?: boolean | string;
    thumbnail_prompt?: string;
    continuity?: boolean | string;
  };
  const id = body.id?.trim() || randomUUID();
  upsertChannel({ ...body, id, name: body.name ?? "" });
  return NextResponse.json({ id });
}

export async function DELETE(req: Request) {
  ensureInit();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  deleteChannel(id);
  return NextResponse.json({ ok: true });
}

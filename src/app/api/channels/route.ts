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
    data_mode?: string;
  };
  const id = body.id?.trim() || randomUUID();
  upsertChannel({
    id,
    name: body.name ?? "",
    scene_split: body.scene_split ?? "",
    image_prompt: body.image_prompt ?? "",
    animation_motion: body.animation_motion ?? "",
    data_mode: body.data_mode,
  });
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

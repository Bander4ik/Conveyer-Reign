import { NextResponse } from "next/server";
import db from "@/lib/db";
import { getLogs } from "@/lib/logger";
import { ensureInit } from "@/lib/init";

const getRun = db.prepare("SELECT * FROM runs WHERE id = ?");

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const run = getRun.get(id);
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ run, logs: getLogs(id) });
}

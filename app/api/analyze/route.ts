import { NextResponse } from "next/server";
import { analyze } from "@/lib/ffmpeg";
import { resolveSafe } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { path: p, seconds } = await req.json();
    const file = resolveSafe(String(p ?? ""));
    const s = Math.min(Math.max(Number(seconds) || 120, 10), 900);
    return NextResponse.json(await analyze(file, s));
  } catch (e: any) {
    const msg = e.code === "ENOENT" && /ffprobe/.test(e.message)
      ? "ffprobe tidak ditemukan. Install ffmpeg atau set FFPROBE_PATH."
      : e.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

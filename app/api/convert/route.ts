import { NextResponse } from "next/server";
import { CONTAINERS, ConvertOpts, PRESETS } from "@/lib/ffmpeg";
import { resolveSafe } from "@/lib/paths";
import { createJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const files: string[] = (body.files ?? []).map((f: string) => resolveSafe(String(f)));
    if (!files.length) throw new Error("Tidak ada file dipilih");

    const o = body.opts ?? {};
    const videoKbps = Number(o.videoKbps);
    if (!Number.isFinite(videoKbps) || videoKbps < 100 || videoKbps > 100000)
      throw new Error("Bitrate video harus 100 - 100000 kbps");
    const audioKbps = Number(o.audioKbps) || 128;
    const opts: ConvertOpts = {
      videoKbps,
      audioKbps: Math.min(Math.max(audioKbps, 32), 512),
      audioMode: o.audioMode === "copy" ? "copy" : "aac",
      preset: PRESETS.includes(o.preset) ? o.preset : "veryfast",
      container: CONTAINERS.includes(o.container) ? o.container : "mp4",
      outDir: o.outDir ? resolveSafe(String(o.outDir)) : undefined,
      suffix: String(o.suffix ?? "_cbr").replace(/[\\/:*?"<>|]/g, ""),
      overwrite: !!o.overwrite,
    };
    return NextResponse.json(createJob(files, opts));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

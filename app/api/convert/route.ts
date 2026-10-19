import { NextResponse } from "next/server";
import { AUDIO_FORMATS, ConvertMode, ConvertOpts, PRESETS, VIDEO_CONTAINERS } from "@/lib/ffmpeg";
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
    const mode: ConvertMode = ["audio_norm_fast", "video_cbr", "audio_only"].includes(o.mode)
      ? o.mode
      : "audio_norm_fast";

    const videoKbps = Number(o.videoKbps) || 4500;
    const audioKbps = Number(o.audioKbps) || 192;
    const audioSampleRate = Number(o.audioSampleRate) || 0;
    const audioChannels = [0, 1, 2].includes(Number(o.audioChannels)) ? (Number(o.audioChannels) as 0 | 1 | 2) : 0;
    const audioFormat = (AUDIO_FORMATS as readonly string[]).includes(o.audioFormat) ? o.audioFormat : "aac";

    const defaultSuffix = mode === "video_cbr" ? "_cbr" : mode === "audio_only" ? "_audio" : "_norm";

    const opts: ConvertOpts = {
      mode,
      videoKbps: Math.min(Math.max(videoKbps, 100), 100000),
      audioKbps: Math.min(Math.max(audioKbps, 32), 512),
      audioFormat,
      audioSampleRate,
      audioChannels,
      preset: PRESETS.includes(o.preset) ? o.preset : "veryfast",
      container: (VIDEO_CONTAINERS as readonly string[]).includes(o.container) ? o.container : "mp4",
      outDir: o.outDir ? resolveSafe(String(o.outDir)) : undefined,
      suffix: String(o.suffix ?? defaultSuffix).replace(/[\\/:*?"<>|]/g, ""),
      overwrite: !!o.overwrite,
    };
    return NextResponse.json(createJob(files, opts));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

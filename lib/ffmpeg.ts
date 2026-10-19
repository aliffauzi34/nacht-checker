import { spawn, execFile, ChildProcess } from "child_process";
import { promisify } from "util";
import path from "path";
import { isAudioExt } from "./paths";

const execFileP = promisify(execFile);
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

export type Verdict = "CBR" | "NEAR_CBR" | "VBR" | "AUDIO_ONLY" | "UNKNOWN";

export type Analysis = {
  mediaType: "video" | "audio";
  codec: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  videoKbps: number; // rata-rata bitrate video (kbps)
  audioKbps: number | null;
  audioCodec: string | null;
  audioSampleRate: number | null; // Hz (misal 48000, 44100)
  audioChannels: number | null; // misal 1 (mono), 2 (stereo)
  audioChannelLayout: string | null; // misal "stereo", "mono"
  hasAudio: boolean;
  hasVideo: boolean;
  series: number[]; // bitrate video per detik (kbps)
  minKbps: number;
  maxKbps: number;
  cv: number; // coefficient of variation (std / mean)
  verdict: Verdict;
};

function parseFps(r?: string): number {
  if (!r || !r.includes("/")) return Number(r) || 0;
  const [a, b] = r.split("/").map(Number);
  return b ? a / b : 0;
}

export async function getDuration(file: string): Promise<number> {
  const { stdout } = await execFileP(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
  ]);
  return Number(stdout.trim()) || 0;
}

/**
 * Deteksi Video & Audio:
 * - Ukur sample rate, codec, channel, bitrate audio
 * - Untuk video: ukur kestabilan bitrate per detik (CBR/VBR)
 */
export async function analyze(file: string, seconds = 120): Promise<Analysis> {
  const { stdout: infoRaw } = await execFileP(
    FFPROBE,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { maxBuffer: 50 * 1024 * 1024 }
  );
  const info = JSON.parse(infoRaw);
  const v = info.streams?.find((s: any) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = info.streams?.find((s: any) => s.codec_type === "audio");

  if (!v && !a) throw new Error("Tidak ada stream video maupun audio di file ini");

  const duration =
    Number(info.format?.duration) ||
    (v ? Number(v.duration) : 0) ||
    (a ? Number(a.duration) : 0) ||
    0;

  // Analisis audio stream
  const hasAudio = !!a;
  const audioSampleRate = a?.sample_rate ? parseInt(a.sample_rate, 10) : null;
  const audioChannels = a?.channels ? Number(a.channels) : null;
  const audioChannelLayout =
    a?.channel_layout ??
    (audioChannels === 2 ? "stereo" : audioChannels === 1 ? "mono" : audioChannels ? `${audioChannels}ch` : null);
  const audioCodec = a?.codec_name ?? null;
  const audioKbps = a?.bit_rate
    ? Math.round(Number(a.bit_rate) / 1000)
    : info.format?.bit_rate && !v
    ? Math.round(Number(info.format.bit_rate) / 1000)
    : null;

  // Jika file audio murni (tanpa video stream)
  if (!v) {
    return {
      mediaType: "audio",
      codec: audioCodec ?? "audio",
      width: 0,
      height: 0,
      fps: 0,
      duration,
      videoKbps: 0,
      audioKbps,
      audioCodec,
      audioSampleRate,
      audioChannels,
      audioChannelLayout,
      hasAudio: true,
      hasVideo: false,
      series: [],
      minKbps: 0,
      maxKbps: 0,
      cv: 0,
      verdict: "AUDIO_ONLY",
    };
  }

  // Jika memiliki video stream
  const { stdout: pk } = await execFileP(
    FFPROBE,
    [
      "-v", "error", "-select_streams", `v:${v.index ?? 0}`,
      "-read_intervals", `%+${seconds}`,
      "-show_entries", "packet=pts_time,dts_time,size",
      "-of", "csv=p=0", file,
    ],
    { maxBuffer: 300 * 1024 * 1024 }
  );

  const pkts: { t: number; bits: number }[] = [];
  let t0 = Infinity;
  for (const line of pk.split("\n")) {
    if (!line) continue;
    const [pts, dts, size] = line.split(",");
    let t = parseFloat(pts);
    if (!Number.isFinite(t)) t = parseFloat(dts);
    const sz = parseInt(size, 10);
    if (!Number.isFinite(t) || !Number.isFinite(sz)) continue;
    if (t < t0) t0 = t;
    pkts.push({ t, bits: sz * 8 });
  }

  const perSec = new Map<number, number>();
  for (const p of pkts) {
    const sec = Math.floor(p.t - t0);
    perSec.set(sec, (perSec.get(sec) || 0) + p.bits);
  }
  const keys = [...perSec.keys()].sort((x, y) => x - y);
  let series = keys.map((k) => (perSec.get(k) || 0) / 1000); // kbps
  if (series.length > 2) series = series.slice(0, -1); // buang detik terakhir (parsial)

  let mean = 0, cv = 0, min = 0, max = 0;
  if (series.length) {
    mean = series.reduce((s, x) => s + x, 0) / series.length;
    const std = Math.sqrt(series.reduce((s, x) => s + (x - mean) ** 2, 0) / series.length);
    cv = mean ? std / mean : 0;
    min = Math.min(...series);
    max = Math.max(...series);
  }

  let verdict: Verdict = "UNKNOWN";
  if (series.length >= 5) {
    verdict = cv <= 0.08 ? "CBR" : cv <= 0.2 ? "NEAR_CBR" : "VBR";
  }

  const headerKbps = Number(v.bit_rate) / 1000 || 0;
  const videoKbps = mean || headerKbps || Number(info.format?.bit_rate) / 1000 || 0;

  return {
    mediaType: "video",
    codec: v.codec_name,
    width: v.width,
    height: v.height,
    fps: parseFps(v.avg_frame_rate || v.r_frame_rate),
    duration,
    videoKbps: Math.round(videoKbps),
    audioKbps,
    audioCodec,
    audioSampleRate,
    audioChannels,
    audioChannelLayout,
    hasAudio,
    hasVideo: true,
    series: series.map((x) => Math.round(x)),
    minKbps: Math.round(min),
    maxKbps: Math.round(max),
    cv: Number(cv.toFixed(3)),
    verdict,
  };
}

export const PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"] as const;
export const VIDEO_CONTAINERS = ["mp4", "mkv", "flv", "ts"] as const;
export const CONTAINERS = VIDEO_CONTAINERS; // alias
export const AUDIO_FORMATS = ["aac", "mp3", "wav", "flac", "copy"] as const;
export const SAMPLE_RATES = [0, 48000, 44100, 96000, 32000, 22050] as const;

export type ConvertMode =
  | "audio_norm_fast" // Fast: Salin video tanpa encode ulang, standarkan sample rate/format audio
  | "video_cbr"       // Video CBR encode + standarkan audio
  | "audio_only";     // Ubah semua input ke file audio mandiri

export type ConvertOpts = {
  mode: ConvertMode;
  // Video opts (khusus video_cbr)
  videoKbps: number;
  preset: (typeof PRESETS)[number];
  container: (typeof VIDEO_CONTAINERS)[number];

  // Audio opts (standarisasi format & sample rate)
  audioFormat: (typeof AUDIO_FORMATS)[number];
  audioKbps: number;
  audioSampleRate: number; // 0 = pertahankan asli, 48000, 44100, dll
  audioChannels: 0 | 1 | 2; // 0 = pertahankan asli, 1 = mono, 2 = stereo

  // Output opts
  outDir?: string;
  suffix: string;
  overwrite: boolean;
};

export function outputPath(input: string, o: ConvertOpts): string {
  const ext = path.extname(input);
  const base = path.basename(input, ext);
  const isAudioInput = isAudioExt(input);

  let targetExt = "";
  if (o.mode === "audio_only") {
    targetExt =
      o.audioFormat === "wav" ? ".wav"
      : o.audioFormat === "mp3" ? ".mp3"
      : o.audioFormat === "flac" ? ".flac"
      : o.audioFormat === "copy" ? (isAudioInput ? ext : ".m4a")
      : ".m4a";
  } else if (o.mode === "audio_norm_fast") {
    if (isAudioInput) {
      targetExt =
        o.audioFormat === "wav" ? ".wav"
        : o.audioFormat === "mp3" ? ".mp3"
        : o.audioFormat === "flac" ? ".flac"
        : o.audioFormat === "copy" ? ext
        : ".m4a";
    } else {
      const lower = ext.toLowerCase();
      targetExt = lower === ".mkv" || lower === ".mp4" || lower === ".mov" || lower === ".ts" ? lower : ".mp4";
    }
  } else {
    // video_cbr
    if (isAudioInput) {
      targetExt =
        o.audioFormat === "wav" ? ".wav"
        : o.audioFormat === "mp3" ? ".mp3"
        : o.audioFormat === "flac" ? ".flac"
        : o.audioFormat === "copy" ? ext
        : ".m4a";
    } else {
      targetExt = `.${o.container}`;
    }
  }

  const defaultFolder = o.mode === "video_cbr" ? "cbr_output" : "normalized_output";
  const dir = o.outDir?.trim()
    ? path.resolve(o.outDir.trim())
    : path.join(path.dirname(input), defaultFolder);

  return path.join(dir, `${base}${o.suffix}${targetExt}`);
}

function appendAudioArgs(args: string[], o: ConvertOpts, outExt: string) {
  // Sample rate resampling
  if (o.audioSampleRate > 0) {
    args.push("-ar", String(o.audioSampleRate));
  }
  // Channels
  if (o.audioChannels === 1) {
    args.push("-ac", "1");
  } else if (o.audioChannels === 2) {
    args.push("-ac", "2");
  }

  const hasResample = o.audioSampleRate > 0 || o.audioChannels > 0;

  if (o.audioFormat === "copy" && !hasResample) {
    args.push("-c:a", "copy");
  } else if (o.audioFormat === "wav" || outExt === ".wav") {
    if (outExt === ".mp4") {
      // mp4 container tidak kompatibel dengan uncompressed PCM standar
      args.push("-c:a", "aac", "-b:a", "256k");
    } else {
      args.push("-c:a", "pcm_s16le");
    }
  } else if (o.audioFormat === "mp3" || outExt === ".mp3") {
    args.push("-c:a", "libmp3lame", "-b:a", `${Math.round(o.audioKbps)}k`);
  } else if (o.audioFormat === "flac" || outExt === ".flac") {
    args.push("-c:a", "flac");
  } else {
    // Default AAC (kompatibilitas tertinggi)
    args.push("-c:a", "aac", "-b:a", `${Math.round(o.audioKbps)}k`);
  }
}

export function convertMedia(
  input: string,
  output: string,
  o: ConvertOpts,
  duration: number,
  onProgress: (p: number) => void,
  onChild: (c: ChildProcess) => void
): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      let hasVideo = false;
      let hasAudio = false;
      try {
        const { stdout: infoRaw } = await execFileP(
          FFPROBE,
          ["-v", "error", "-print_format", "json", "-show_streams", input]
        );
        const info = JSON.parse(infoRaw);
        hasVideo = !!info.streams?.find((s: any) => s.codec_type === "video" && !s.disposition?.attached_pic);
        hasAudio = !!info.streams?.find((s: any) => s.codec_type === "audio");
      } catch {
        hasVideo = !isAudioExt(input);
        hasAudio = true;
      }

      const outExt = path.extname(output).toLowerCase();
      const args: string[] = [
        "-hide_banner",
        "-loglevel", "error",
        o.overwrite ? "-y" : "-n",
        "-i", input,
      ];

      if (o.mode === "audio_only" || (!hasVideo && hasAudio)) {
        args.push("-vn");
        if (hasAudio) {
          args.push("-map", "0:a:0");
          appendAudioArgs(args, o, outExt);
        }
      } else if (o.mode === "audio_norm_fast") {
        if (hasVideo) {
          args.push("-map", "0:v:0", "-c:v", "copy");
        }
        if (hasAudio) {
          args.push("-map", "0:a:0?");
          appendAudioArgs(args, o, outExt);
        }
        if (outExt === ".mp4") {
          args.push("-movflags", "+faststart");
        }
      } else {
        // video_cbr
        if (hasVideo) {
          const k = Math.round(o.videoKbps);
          args.push(
            "-map", "0:v:0",
            "-c:v", "libx264",
            "-preset", o.preset,
            "-b:v", `${k}k`,
            "-minrate", `${k}k`,
            "-maxrate", `${k}k`,
            "-bufsize", `${k * 2}k`,
            "-x264-params", "nal-hrd=cbr:force-cfr=1",
            "-pix_fmt", "yuv420p"
          );
        }
        if (hasAudio) {
          args.push("-map", "0:a:0?");
          appendAudioArgs(args, o, outExt);
        }
        if (outExt === ".mp4") {
          args.push("-movflags", "+faststart");
        }
      }

      args.push("-progress", "pipe:1", "-nostats", output);

      const child = spawn(FFMPEG, args);
      onChild(child);

      let err = "";
      child.stderr.on("data", (d) => {
        err = (err + d.toString()).slice(-2000);
      });
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
          if (m && duration > 0) onProgress(Math.min(0.999, Number(m[1]) / 1e6 / duration));
        }
      });
      child.on("error", (e) => reject(new Error(`Gagal menjalankan ffmpeg: ${e.message}`)));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(err.trim() || `ffmpeg keluar dengan kode ${code}`));
      });
    } catch (e: any) {
      reject(e);
    }
  });
}

// Alias untuk kompatibilitas
export const convertToCbr = convertMedia;

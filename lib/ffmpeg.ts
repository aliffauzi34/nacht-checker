import { spawn, execFile, ChildProcess } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileP = promisify(execFile);
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

export type Verdict = "CBR" | "NEAR_CBR" | "VBR" | "UNKNOWN";

export type Analysis = {
  codec: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  videoKbps: number; // rata-rata bitrate video (kbps)
  audioKbps: number | null;
  audioCodec: string | null;
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
 * Deteksi CBR/VBR: ukur bitrate video tiap detik dari ukuran packet,
 * lalu lihat seberapa stabil (coefficient of variation).
 */
export async function analyze(file: string, seconds = 120): Promise<Analysis> {
  const { stdout: infoRaw } = await execFileP(
    FFPROBE,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { maxBuffer: 50 * 1024 * 1024 }
  );
  const info = JSON.parse(infoRaw);
  const v = info.streams?.find((s: any) => s.codec_type === "video");
  const a = info.streams?.find((s: any) => s.codec_type === "audio");
  if (!v) throw new Error("Tidak ada stream video");

  const duration = Number(info.format?.duration) || Number(v.duration) || 0;

  const { stdout: pk } = await execFileP(
    FFPROBE,
    [
      "-v", "error", "-select_streams", "v:0",
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
    codec: v.codec_name,
    width: v.width,
    height: v.height,
    fps: parseFps(v.avg_frame_rate || v.r_frame_rate),
    duration,
    videoKbps: Math.round(videoKbps),
    audioKbps: a?.bit_rate ? Math.round(Number(a.bit_rate) / 1000) : null,
    audioCodec: a?.codec_name ?? null,
    series: series.map((x) => Math.round(x)),
    minKbps: Math.round(min),
    maxKbps: Math.round(max),
    cv: Number(cv.toFixed(3)),
    verdict,
  };
}

export const PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"] as const;
export const CONTAINERS = ["mp4", "mkv", "flv", "ts"] as const;

export type ConvertOpts = {
  videoKbps: number;
  audioMode: "aac" | "copy";
  audioKbps: number;
  preset: (typeof PRESETS)[number];
  container: (typeof CONTAINERS)[number];
  outDir?: string;
  suffix: string;
  overwrite: boolean;
};

export function outputPath(input: string, o: ConvertOpts): string {
  const base = path.basename(input, path.extname(input));
  const dir = o.outDir?.trim()
    ? path.resolve(o.outDir.trim())
    : path.join(path.dirname(input), "cbr_output");
  return path.join(dir, `${base}${o.suffix}.${o.container}`);
}

export function convertToCbr(
  input: string,
  output: string,
  o: ConvertOpts,
  duration: number,
  onProgress: (p: number) => void,
  onChild: (c: ChildProcess) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const k = Math.round(o.videoKbps);
    const args = [
      "-hide_banner", "-loglevel", "error",
      o.overwrite ? "-y" : "-n",
      "-i", input,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", o.preset,
      "-b:v", `${k}k`, "-minrate", `${k}k`, "-maxrate", `${k}k`, "-bufsize", `${k * 2}k`,
      "-x264-params", "nal-hrd=cbr:force-cfr=1",
      "-pix_fmt", "yuv420p",
    ];
    if (o.audioMode === "copy") args.push("-c:a", "copy");
    else args.push("-c:a", "aac", "-b:a", `${Math.round(o.audioKbps)}k`);
    if (o.container === "mp4") args.push("-movflags", "+faststart");
    args.push("-progress", "pipe:1", "-nostats", output);

    const child = spawn(FFMPEG, args);
    onChild(child);

    let err = "";
    child.stderr.on("data", (d) => { err = (err + d.toString()).slice(-2000); });
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
  });
}

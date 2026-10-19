import path from "path";

export const VIDEO_EXT = new Set([
  ".mp4", ".mkv", ".mov", ".avi", ".flv", ".ts", ".webm", ".m4v", ".mpg", ".mpeg", ".wmv",
]);

export const AUDIO_EXT = new Set([
  ".mp3", ".wav", ".aac", ".m4a", ".flac", ".ogg", ".opus", ".wma", ".aiff", ".alac",
]);

export const MEDIA_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT]);

export function isAudioExt(p: string): boolean {
  return AUDIO_EXT.has(path.extname(p).toLowerCase());
}

export function isVideoExt(p: string): boolean {
  return VIDEO_EXT.has(path.extname(p).toLowerCase());
}

/** Resolve path & (opsional) batasi ke MEDIA_ROOT. */
export function resolveSafe(p: string): string {
  if (!p || !p.trim()) throw new Error("Path kosong");
  const abs = path.resolve(p.trim());
  const root = process.env.MEDIA_ROOT;
  if (root) {
    const r = path.resolve(root);
    if (abs !== r && !abs.startsWith(r + path.sep)) {
      throw new Error("Path di luar MEDIA_ROOT");
    }
  }
  return abs;
}

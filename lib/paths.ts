import path from "path";

export const VIDEO_EXT = new Set([
  ".mp4", ".mkv", ".mov", ".avi", ".flv", ".ts", ".webm", ".m4v", ".mpg", ".mpeg", ".wmv",
]);

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

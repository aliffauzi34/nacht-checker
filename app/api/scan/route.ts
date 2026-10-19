import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { resolveSafe, MEDIA_EXT, isAudioExt } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 2000;
type F = { path: string; name: string; size: number; kind: "video" | "audio" };

async function walk(dir: string, recursive: boolean, out: F[]) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (out.length >= LIMIT) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (
        recursive &&
        e.name !== "cbr_output" &&
        e.name !== "normalized_output" &&
        e.name !== "audio_output" &&
        !e.name.startsWith(".")
      ) {
        await walk(full, recursive, out);
      }
    } else {
      const ext = path.extname(e.name).toLowerCase();
      if (MEDIA_EXT.has(ext)) {
        const st = await fs.stat(full);
        out.push({
          path: full,
          name: e.name,
          size: st.size,
          kind: isAudioExt(full) ? "audio" : "video",
        });
      }
    }
  }
}

export async function POST(req: Request) {
  try {
    const { dir, recursive } = await req.json();
    const abs = resolveSafe(String(dir ?? ""));
    const st = await fs.stat(abs);
    const files: F[] = [];
    if (st.isFile()) {
      files.push({
        path: abs,
        name: path.basename(abs),
        size: st.size,
        kind: isAudioExt(abs) ? "audio" : "video",
      });
    } else {
      await walk(abs, !!recursive, files);
    }
    files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    return NextResponse.json({ files, truncated: files.length >= LIMIT });
  } catch (e: any) {
    const msg = e.code === "ENOENT" ? "Folder/file tidak ditemukan" : e.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

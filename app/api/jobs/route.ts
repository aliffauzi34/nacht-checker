import { NextResponse } from "next/server";
import { cancelJob, getJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const job = getJob(id);
  if (!job) return NextResponse.json({ error: "Job tidak ditemukan" }, { status: 404 });
  return NextResponse.json(job);
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  return NextResponse.json({ ok: cancelJob(id) });
}

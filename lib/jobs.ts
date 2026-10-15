import fs from "fs/promises";
import path from "path";
import { ChildProcess } from "child_process";
import { ConvertOpts, convertToCbr, getDuration, outputPath } from "./ffmpeg";

export type JobItem = {
  path: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  progress: number;
  output?: string;
  error?: string;
};
export type Job = {
  id: string;
  status: "running" | "done" | "cancelled";
  items: JobItem[];
};

type Internal = Job & { cancelled: boolean; child?: ChildProcess };

const g = globalThis as unknown as { __jobs?: Map<string, Internal> };
const jobs = (g.__jobs ??= new Map<string, Internal>());

const exists = (p: string) => fs.access(p).then(() => true, () => false);

export function createJob(files: string[], opts: ConvertOpts): Job {
  const id = Math.random().toString(36).slice(2, 10);
  const job: Internal = {
    id,
    status: "running",
    cancelled: false,
    items: files.map((p) => ({ path: p, status: "queued", progress: 0 })),
  };
  jobs.set(id, job);
  void run(job, opts);
  return view(job);
}

export function getJob(id: string): Job | null {
  const j = jobs.get(id);
  return j ? view(j) : null;
}

export function cancelJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j) return false;
  j.cancelled = true;
  j.child?.kill("SIGKILL");
  return true;
}

function view(j: Internal): Job {
  return { id: j.id, status: j.status, items: j.items.map((i) => ({ ...i })) };
}

async function run(job: Internal, opts: ConvertOpts) {
  for (const item of job.items) {
    if (job.cancelled) { item.status = "skipped"; continue; }
    item.status = "running";
    try {
      const out = outputPath(item.path, opts);
      item.output = out;
      if (path.resolve(out) === path.resolve(item.path)) throw new Error("Output sama dengan file input");
      await fs.mkdir(path.dirname(out), { recursive: true });
      if (!opts.overwrite && (await exists(out))) {
        item.status = "skipped";
        item.error = "File output sudah ada";
        continue;
      }
      const dur = await getDuration(item.path);
      await convertToCbr(item.path, out, opts, dur, (p) => (item.progress = p), (c) => (job.child = c));
      item.status = "done";
      item.progress = 1;
    } catch (e: any) {
      if (job.cancelled) {
        item.status = "skipped";
        item.error = "Dibatalkan";
        if (item.output) await fs.rm(item.output, { force: true });
      } else {
        item.status = "error";
        item.error = e.message;
      }
    }
  }
  job.status = job.cancelled ? "cancelled" : "done";
}

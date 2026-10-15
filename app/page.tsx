"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Verdict = "CBR" | "NEAR_CBR" | "VBR" | "UNKNOWN";
type FileRow = { path: string; name: string; size: number };
type Analysis = {
  codec: string; width: number; height: number; fps: number; duration: number;
  videoKbps: number; audioKbps: number | null; audioCodec: string | null;
  series: number[]; minKbps: number; maxKbps: number; cv: number; verdict: Verdict;
};
type Row = FileRow & { state: "idle" | "loading" | "done" | "error"; a?: Analysis; error?: string };
type JobItem = { path: string; status: "queued" | "running" | "done" | "error" | "skipped"; progress: number; output?: string; error?: string };
type Job = { id: string; status: "running" | "done" | "cancelled"; items: JobItem[] };

const LABEL: Record<Verdict, string> = { CBR: "CBR", NEAR_CBR: "Mendekati CBR", VBR: "VBR", UNKNOWN: "Tidak pasti" };

const fmtSize = (b: number) =>
  b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`;
const fmtDur = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
const splitPath = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? ["", p] : [p.slice(0, i), p.slice(i + 1)];
};

async function api<T>(url: string, body?: unknown, method = "POST"): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Request gagal");
  return j as T;
}

/** Garis rata = CBR, bergerigi = VBR. Skala 0..2x rata-rata supaya variasi kelihatan. */
function Sparkline({ series, kbps }: { series: number[]; kbps: number }) {
  const W = 150, H = 34;
  if (series.length < 2 || !kbps) return <svg width={W} height={H} aria-hidden />;
  const top = kbps * 2;
  const pts = series.map((v, i) => {
    const x = (i / (series.length - 1)) * W;
    const y = H - Math.min(v / top, 1) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Bitrate per detik, rata-rata ${kbps} kbps`}>
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="var(--line)" strokeDasharray="3 3" />
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export default function Page() {
  const [dir, setDir] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanErr, setScanErr] = useState("");
  const [scanning, setScanning] = useState(false);

  const [videoKbps, setVideoKbps] = useState("4500");
  const [audioMode, setAudioMode] = useState<"aac" | "copy">("aac");
  const [audioKbps, setAudioKbps] = useState("128");
  const [preset, setPreset] = useState("veryfast");
  const [container, setContainer] = useState("mp4");
  const [outDir, setOutDir] = useState("");
  const [suffix, setSuffix] = useState("_cbr");
  const [overwrite, setOverwrite] = useState(false);

  const [job, setJob] = useState<Job | null>(null);
  const [convErr, setConvErr] = useState("");
  const runId = useRef(0);

  async function scan() {
    setScanErr(""); setScanning(true); setRows([]); setSelected(new Set()); setJob(null);
    const id = ++runId.current;
    try {
      const { files, truncated } = await api<{ files: FileRow[]; truncated: boolean }>("/api/scan", { dir, recursive });
      if (!files.length) { setScanErr("Tidak ada file video di lokasi ini."); return; }
      if (truncated) setScanErr("Hanya 2000 file pertama yang ditampilkan.");
      const initial: Row[] = files.map((f) => ({ ...f, state: "idle" }));
      setRows(initial);
      // analisis 3 file sekaligus
      let next = 0;
      const worker = async () => {
        while (next < files.length && runId.current === id) {
          const f = files[next++];
          setRows((r) => r.map((x) => (x.path === f.path ? { ...x, state: "loading" } : x)));
          try {
            const a = await api<Analysis>("/api/analyze", { path: f.path });
            setRows((r) => r.map((x) => (x.path === f.path ? { ...x, state: "done", a } : x)));
          } catch (e: any) {
            setRows((r) => r.map((x) => (x.path === f.path ? { ...x, state: "error", error: e.message } : x)));
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    } catch (e: any) {
      setScanErr(e.message);
    } finally {
      setScanning(false);
    }
  }

  // polling job
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(async () => {
      try { setJob(await api<Job>(`/api/jobs?id=${job.id}`, undefined, "GET")); } catch {}
    }, 1000);
    return () => clearInterval(t);
  }, [job]);

  const toggle = (p: string) =>
    setSelected((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const selectWhere = (fn: (r: Row) => boolean) => setSelected(new Set(rows.filter(fn).map((r) => r.path)));

  async function convert() {
    setConvErr("");
    try {
      const j = await api<Job>("/api/convert", {
        files: rows.filter((r) => selected.has(r.path)).map((r) => r.path),
        opts: { videoKbps: Number(videoKbps), audioMode, audioKbps: Number(audioKbps), preset, container, outDir, suffix, overwrite },
      });
      setJob(j);
    } catch (e: any) { setConvErr(e.message); }
  }
  const cancel = async () => { if (job) await api(`/api/jobs?id=${job.id}`, undefined, "DELETE"); };

  const jobMap = useMemo(() => new Map(job?.items.map((i) => [i.path, i])), [job]);
  const running = job?.status === "running";
  const doneCount = job?.items.filter((i) => i.status === "done").length ?? 0;
  const vbrCount = rows.filter((r) => r.a && r.a.verdict !== "CBR").length;

  return (
    <main className="wrap">
      <p className="brand">Nacht Checker</p>
      <h1>Cek bitrate video, ubah ke CBR</h1>
      <p className="lede">
        Masukkan folder video di komputer yang menjalankan app ini. Setiap file dicek bitrate per detiknya,
        lalu pilih yang mau diubah ke CBR dengan bitrate sesuai keinginanmu.
      </p>

      <section className="source">
        <label className="field">
          <span>Folder atau file video</span>
          <input type="text" value={dir} onChange={(e) => setDir(e.target.value)}
            placeholder="/home/user/videos  atau  D:\Videos"
            onKeyDown={(e) => e.key === "Enter" && dir && scan()} />
        </label>
        <label className="check">
          <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
          Termasuk subfolder
        </label>
        <button onClick={scan} disabled={!dir.trim() || scanning}>{scanning ? "Memeriksa…" : "Cek video"}</button>
      </section>
      {scanErr && <p className="error" role="alert">{scanErr}</p>}

      {rows.length > 0 && (
        <>
          <div className="toolbar">
            <h2>{rows.length} file</h2>
            <span className="count">{selected.size} dipilih{vbrCount ? `, ${vbrCount} bukan CBR` : ""}</span>
            <span className="spacer" />
            <button className="ghost" onClick={() => selectWhere(() => true)}>Pilih semua</button>
            <button className="ghost" onClick={() => selectWhere((r) => !!r.a && r.a.verdict !== "CBR")}>Pilih yang bukan CBR</button>
            <button className="ghost" onClick={() => setSelected(new Set())}>Kosongkan</button>
          </div>

          <div className="tablebox">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 36 }}></th>
                  <th>File</th>
                  <th>Bitrate per detik</th>
                  <th>Tipe</th>
                  <th className="num">Video</th>
                  <th className="num">Audio</th>
                  <th>Format</th>
                  <th className="num">Ukuran</th>
                  <th>Konversi</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const [d, n] = splitPath(r.path);
                  const ji = jobMap.get(r.path);
                  return (
                    <tr key={r.path}>
                      <td>
                        <input type="checkbox" aria-label={`Pilih ${n}`} checked={selected.has(r.path)}
                          onChange={() => toggle(r.path)} disabled={running} />
                      </td>
                      <td><div className="fname">{n}</div><div className="fdir">{d}</div></td>
                      {r.state === "done" && r.a ? (
                        <>
                          <td style={{ color: `var(--${r.a.verdict === "CBR" ? "cbr" : r.a.verdict === "NEAR_CBR" ? "near" : r.a.verdict === "VBR" ? "vbr" : "muted"})` }}>
                            <Sparkline series={r.a.series} kbps={r.a.videoKbps} />
                          </td>
                          <td>
                            <span className={`badge ${r.a.verdict}`}>{LABEL[r.a.verdict]}</span>
                            <div className="sub">variasi {(r.a.cv * 100).toFixed(1)}%</div>
                          </td>
                          <td className="num">
                            <strong>{r.a.videoKbps.toLocaleString("id-ID")}</strong> kbps
                            <div className="sub">{r.a.minKbps}–{r.a.maxKbps}</div>
                          </td>
                          <td className="num">{r.a.audioKbps ? `${r.a.audioKbps} kbps` : "–"}
                            <div className="sub">{r.a.audioCodec ?? "tanpa audio"}</div></td>
                          <td>{r.a.codec}<div className="sub">{r.a.width}×{r.a.height} · {r.a.fps.toFixed(2)} fps · {fmtDur(r.a.duration)}</div></td>
                        </>
                      ) : (
                        <td colSpan={5} className={r.state === "error" ? "st-error" : "pulse"}>
                          {r.state === "error" ? r.error : r.state === "loading" ? "Menganalisis…" : "Menunggu giliran"}
                        </td>
                      )}
                      <td className="num">{fmtSize(r.size)}</td>
                      <td>
                        {ji ? (
                          ji.status === "running" ? (
                            <div className="bar" role="progressbar" aria-valuenow={Math.round(ji.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                              <i style={{ width: `${ji.progress * 100}%` }} />
                            </div>
                          ) : ji.status === "done" ? <span className="st-done">Selesai</span>
                            : ji.status === "queued" ? <span className="pulse">Antre</span>
                            : <span className="st-error">{ji.status === "skipped" ? "Dilewati" : "Gagal"}{ji.error ? `: ${ji.error}` : ""}</span>
                        ) : <span className="sub">–</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {rows.length === 0 && !scanning && (
        <div className="empty tablebox" style={{ marginTop: 26 }}>Belum ada video. Isi lokasi folder di atas lalu klik “Cek video”.</div>
      )}

      <section className="dock" aria-label="Pengaturan konversi CBR">
        <div className="dock-in">
          <div className="opts">
            <label className="field"><span>Bitrate video CBR (kbps)</span>
              <input type="number" min={100} max={100000} step={100} value={videoKbps} onChange={(e) => setVideoKbps(e.target.value)} disabled={running} /></label>
            <label className="field"><span>Audio</span>
              <select value={audioMode} onChange={(e) => setAudioMode(e.target.value as "aac" | "copy")} disabled={running}>
                <option value="aac">Encode AAC</option><option value="copy">Salin asli</option></select></label>
            <label className="field"><span>Bitrate audio (kbps)</span>
              <input type="number" min={32} max={512} step={16} value={audioKbps} onChange={(e) => setAudioKbps(e.target.value)} disabled={running || audioMode === "copy"} /></label>
            <label className="field"><span>Kecepatan encode</span>
              <select value={preset} onChange={(e) => setPreset(e.target.value)} disabled={running}>
                {["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"].map((p) => <option key={p}>{p}</option>)}</select></label>
            <label className="field"><span>Format output</span>
              <select value={container} onChange={(e) => setContainer(e.target.value)} disabled={running}>
                {["mp4", "mkv", "flv", "ts"].map((p) => <option key={p}>{p}</option>)}</select></label>
            <label className="field"><span>Akhiran nama file</span>
              <input type="text" value={suffix} onChange={(e) => setSuffix(e.target.value)} disabled={running} /></label>
            <label className="field wide"><span>Folder output (kosong = subfolder cbr_output)</span>
              <input type="text" value={outDir} onChange={(e) => setOutDir(e.target.value)} disabled={running} /></label>
          </div>
          <div className="dock-actions">
            <button onClick={convert} disabled={!selected.size || running}>
              {running ? "Mengonversi…" : `Ubah ${selected.size || ""} file ke CBR ${Number(videoKbps) || ""} kbps`}
            </button>
            {running && <button className="ghost" onClick={cancel}>Batalkan</button>}
            <label className="check" style={{ paddingBottom: 0 }}>
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} disabled={running} />
              Timpa file output yang sudah ada
            </label>
            <span className="spacer" />
            {job && <span className="hint">{doneCount}/{job.items.length} selesai{job.status === "cancelled" ? " (dibatalkan)" : ""}</span>}
            {convErr && <span className="error" role="alert" style={{ margin: 0 }}>{convErr}</span>}
          </div>
          <p className="hint" style={{ margin: "8px 0 0" }}>
            File asli tidak diubah; hasil disimpan sebagai file baru. Konversi CBR memakai re-encode, jadi butuh waktu dan CPU.
          </p>
        </div>
      </section>
    </main>
  );
}

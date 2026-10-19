"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Verdict = "CBR" | "NEAR_CBR" | "VBR" | "AUDIO_ONLY" | "UNKNOWN";
type FileRow = { path: string; name: string; size: number; kind: "video" | "audio" };
type Analysis = {
  mediaType: "video" | "audio";
  codec: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  videoKbps: number;
  audioKbps: number | null;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  audioChannelLayout: string | null;
  hasAudio: boolean;
  hasVideo: boolean;
  series: number[];
  minKbps: number;
  maxKbps: number;
  cv: number;
  verdict: Verdict;
};
type Row = FileRow & { state: "idle" | "loading" | "done" | "error"; a?: Analysis; error?: string };
type JobItem = {
  path: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  progress: number;
  output?: string;
  error?: string;
};
type Job = { id: string; status: "running" | "done" | "cancelled"; items: JobItem[] };

const LABEL: Record<Verdict, string> = {
  CBR: "CBR",
  NEAR_CBR: "Mendekati CBR",
  VBR: "VBR",
  AUDIO_ONLY: "Audio",
  UNKNOWN: "Tidak pasti",
};

const fmtSize = (b: number) =>
  b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`;

const fmtDur = (s: number) => {
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    x = Math.floor(s % 60);
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`
    : `${m}:${String(x).padStart(2, "0")}`;
};

const splitPath = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? ["", p] : [p.slice(0, i), p.slice(i + 1)];
};

const fmtSampleRate = (sr: number | null) => {
  if (!sr) return "Tanpa Audio";
  if (sr === 48000) return "48.000 Hz (48k)";
  if (sr === 44100) return "44.100 Hz (44.1k)";
  if (sr === 96000) return "96.000 Hz (96k)";
  if (sr === 32000) return "32.000 Hz (32k)";
  return `${sr.toLocaleString("id-ID")} Hz`;
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

/** Garis rata = CBR, bergerigi = VBR. */
function Sparkline({ series, kbps }: { series: number[]; kbps: number }) {
  const W = 130,
    H = 30;
  if (series.length < 2 || !kbps) return <svg width={W} height={H} aria-hidden />;
  const top = kbps * 2;
  const pts = series.map((v, i) => {
    const x = (i / (series.length - 1)) * W;
    const y = H - Math.min(v / top, 1) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      className="spark"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Bitrate per detik, rata-rata ${kbps} kbps`}
    >
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="var(--line)" strokeDasharray="3 3" />
      <polyline points={pts.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export default function Page() {
  // Menu aktif di sidebar: "video" = Video CBR Checker, "audio" = Audio Normalizer
  const [activeMenu, setActiveMenu] = useState<"video" | "audio">("audio");

  // ==================== STATE VIDEO CBR ====================
  const [videoDir, setVideoDir] = useState("");
  const [videoRecursive, setVideoRecursive] = useState(false);
  const [videoRows, setVideoRows] = useState<Row[]>([]);
  const [videoSelected, setVideoSelected] = useState<Set<string>>(new Set());
  const [videoScanErr, setVideoScanErr] = useState("");
  const [videoScanning, setVideoScanning] = useState(false);

  // Opsi CBR Video
  const [videoCbrKbps, setVideoCbrKbps] = useState("4500");
  const [videoAudioMode, setVideoAudioMode] = useState<"aac" | "copy">("aac");
  const [videoAudioKbps, setVideoAudioKbps] = useState("128");
  const [videoPreset, setVideoPreset] = useState("veryfast");
  const [videoContainer, setVideoContainer] = useState("mp4");
  const [videoOutDir, setVideoOutDir] = useState("");
  const [videoSuffix, setVideoSuffix] = useState("_cbr");
  const [videoOverwrite, setVideoOverwrite] = useState(false);
  const [videoJob, setVideoJob] = useState<Job | null>(null);
  const [videoConvErr, setVideoConvErr] = useState("");
  const videoRunId = useRef(0);

  // ==================== STATE AUDIO NORMALIZER ====================
  const [audioDir, setAudioDir] = useState("");
  const [audioRecursive, setAudioRecursive] = useState(false);
  const [audioRows, setAudioRows] = useState<Row[]>([]);
  const [audioSelected, setAudioSelected] = useState<Set<string>>(new Set());
  const [audioScanErr, setAudioScanErr] = useState("");
  const [audioScanning, setAudioScanning] = useState(false);

  // Opsi Standarisasi Audio
  const [targetSampleRate, setTargetSampleRate] = useState<number>(48000);
  const [targetFormat, setTargetFormat] = useState<"aac" | "mp3" | "wav" | "flac">("aac");
  const [targetAudioKbps, setTargetAudioKbps] = useState("192");
  const [targetChannels, setTargetChannels] = useState<number>(2); // 2 = Wajib Stereo
  const [audioAction, setAudioAction] = useState<"audio_norm_fast" | "audio_only">("audio_norm_fast");
  const [audioOutDir, setAudioOutDir] = useState("");
  const [audioSuffix, setAudioSuffix] = useState("_norm");
  const [audioOverwrite, setAudioOverwrite] = useState(false);
  const [audioJob, setAudioJob] = useState<Job | null>(null);
  const [audioConvErr, setAudioConvErr] = useState("");
  const audioRunId = useRef(0);

  // Polling Job Video
  useEffect(() => {
    if (!videoJob || videoJob.status !== "running") return;
    const t = setInterval(async () => {
      try {
        setVideoJob(await api<Job>(`/api/jobs?id=${videoJob.id}`, undefined, "GET"));
      } catch {}
    }, 1000);
    return () => clearInterval(t);
  }, [videoJob]);

  // Polling Job Audio
  useEffect(() => {
    if (!audioJob || audioJob.status !== "running") return;
    const t = setInterval(async () => {
      try {
        setAudioJob(await api<Job>(`/api/jobs?id=${audioJob.id}`, undefined, "GET"));
      } catch {}
    }, 1000);
    return () => clearInterval(t);
  }, [audioJob]);

  // ==================== SCAN VIDEO ====================
  async function scanVideo() {
    setVideoScanErr("");
    setVideoScanning(true);
    setVideoRows([]);
    setVideoSelected(new Set());
    setVideoJob(null);
    const id = ++videoRunId.current;
    try {
      const { files, truncated } = await api<{ files: FileRow[]; truncated: boolean }>("/api/scan", {
        dir: videoDir,
        recursive: videoRecursive,
      });
      // Hanya ambil file video
      const vFiles = files.filter((f) => f.kind === "video");
      if (!vFiles.length) {
        setVideoScanErr("Tidak ada file video di lokasi ini.");
        return;
      }
      if (truncated) setVideoScanErr("Hanya 2000 file pertama yang ditampilkan.");
      setVideoRows(vFiles.map((f) => ({ ...f, state: "idle" })));

      let next = 0;
      const worker = async () => {
        while (next < vFiles.length && videoRunId.current === id) {
          const f = vFiles[next++];
          setVideoRows((r) => r.map((x) => (x.path === f.path ? { ...x, state: "loading" } : x)));
          try {
            const a = await api<Analysis>("/api/analyze", { path: f.path });
            setVideoRows((r) => r.map((x) => (x.path === f.path ? { ...x, state: "done", a } : x)));
          } catch (e: any) {
            setVideoRows((r) => r.map((x) => (x.path === f.path ? { ...x, state: "error", error: e.message } : x)));
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    } catch (e: any) {
      setVideoScanErr(e.message);
    } finally {
      setVideoScanning(false);
    }
  }

  // ==================== SCAN AUDIO ====================
  async function scanAudio() {
    setAudioScanErr("");
    setAudioScanning(true);
    setAudioRows([]);
    setAudioSelected(new Set());
    setAudioJob(null);
    const id = ++audioRunId.current;
    try {
      const { files, truncated } = await api<{ files: FileRow[]; truncated: boolean }>("/api/scan", {
        dir: audioDir,
        recursive: audioRecursive,
      });
      if (!files.length) {
        setAudioScanErr("Tidak ada file media di lokasi ini.");
        return;
      }
      if (truncated) setAudioScanErr("Hanya 2000 file pertama yang ditampilkan.");
      setAudioRows(files.map((f) => ({ ...f, state: "idle" })));

      let next = 0;
      const worker = async () => {
        while (next < files.length && audioRunId.current === id) {
          const f = files[next++];
          setAudioRows((r) => r.map((x) => (x.path === f.path ? { ...x, state: "loading" } : x)));
          try {
            const a = await api<Analysis>("/api/analyze", { path: f.path });
            setAudioRows((r) => r.map((x) => (x.path === f.path ? { ...x, state: "done", a } : x)));
          } catch (e: any) {
            setAudioRows((r) => r.map((x) => (x.path === f.path ? { ...x, state: "error", error: e.message } : x)));
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    } catch (e: any) {
      setAudioScanErr(e.message);
    } finally {
      setAudioScanning(false);
    }
  }

  // Konversi Video CBR
  async function convertVideo() {
    setVideoConvErr("");
    try {
      const j = await api<Job>("/api/convert", {
        files: videoRows.filter((r) => videoSelected.has(r.path)).map((r) => r.path),
        opts: {
          mode: "video_cbr",
          videoKbps: Number(videoCbrKbps),
          audioMode: videoAudioMode,
          audioKbps: Number(videoAudioKbps),
          preset: videoPreset,
          container: videoContainer,
          outDir: videoOutDir,
          suffix: videoSuffix,
          overwrite: videoOverwrite,
        },
      });
      setVideoJob(j);
    } catch (e: any) {
      setVideoConvErr(e.message);
    }
  }

  // Standarisasi Masal Audio
  async function convertAudio() {
    setAudioConvErr("");
    try {
      const j = await api<Job>("/api/convert", {
        files: audioRows.filter((r) => audioSelected.has(r.path)).map((r) => r.path),
        opts: {
          mode: audioAction,
          audioFormat: targetFormat,
          audioSampleRate: Number(targetSampleRate),
          audioKbps: Number(targetAudioKbps),
          audioChannels: Number(targetChannels), // 2 = Stereo
          outDir: audioOutDir,
          suffix: audioSuffix,
          overwrite: audioOverwrite,
        },
      });
      setAudioJob(j);
    } catch (e: any) {
      setAudioConvErr(e.message);
    }
  }

  const cancelVideo = async () => {
    if (videoJob) await api(`/api/jobs?id=${videoJob.id}`, undefined, "DELETE");
  };
  const cancelAudio = async () => {
    if (audioJob) await api(`/api/jobs?id=${audioJob.id}`, undefined, "DELETE");
  };

  // Preset 1-Klik Standarisasi Audio
  function applyAudioPreset(sr: number, ch: number, fmt: "aac" | "mp3" | "wav" | "flac", kbps: string) {
    setTargetSampleRate(sr);
    setTargetChannels(ch);
    setTargetFormat(fmt);
    setTargetAudioKbps(kbps);
  }

  // Statistik Audio Normalizer
  const audioStats = useMemo(() => {
    const done = audioRows.filter((r) => r.state === "done" && r.a);
    const srCounts = new Map<number, number>();
    const chCounts = new Map<string, number>();
    const codecCounts = new Map<string, number>();
    let monoCount = 0;
    let nonTargetSrCount = 0;
    let nonTargetCodecCount = 0;

    for (const r of done) {
      const a = r.a!;
      if (a.hasAudio && a.audioSampleRate) {
        srCounts.set(a.audioSampleRate, (srCounts.get(a.audioSampleRate) || 0) + 1);
        if (a.audioSampleRate !== targetSampleRate) nonTargetSrCount++;

        const isStereo = a.audioChannels === 2 || a.audioChannelLayout?.toLowerCase().includes("stereo");
        const chKey = isStereo ? "Stereo" : a.audioChannels === 1 ? "Mono" : `${a.audioChannels} ch`;
        chCounts.set(chKey, (chCounts.get(chKey) || 0) + 1);
        if (!isStereo) monoCount++;

        const codec = (a.audioCodec || "audio").toUpperCase();
        codecCounts.set(codec, (codecCounts.get(codec) || 0) + 1);
        if (a.audioCodec?.toLowerCase() !== targetFormat.toLowerCase()) nonTargetCodecCount++;
      }
    }

    const rates = Array.from(srCounts.entries()).sort((a, b) => b[1] - a[1]);
    const channels = Array.from(chCounts.entries()).sort((a, b) => b[1] - a[1]);
    const codecs = Array.from(codecCounts.entries()).sort((a, b) => b[1] - a[1]);
    const hasMismatch = rates.length > 1 || monoCount > 0 || nonTargetCodecCount > 0;

    return {
      totalDone: done.length,
      rates,
      channels,
      codecs,
      monoCount,
      nonTargetSrCount,
      nonTargetCodecCount,
      hasMismatch,
    };
  }, [audioRows, targetSampleRate, targetFormat]);

  const videoJobMap = useMemo(() => new Map(videoJob?.items.map((i) => [i.path, i])), [videoJob]);
  const audioJobMap = useMemo(() => new Map(audioJob?.items.map((i) => [i.path, i])), [audioJob]);

  const videoRunning = videoJob?.status === "running";
  const videoDoneCount = videoJob?.items.filter((i) => i.status === "done").length ?? 0;
  const videoVbrCount = videoRows.filter((r) => r.a && r.a.verdict !== "CBR").length;

  const audioRunning = audioJob?.status === "running";
  const audioDoneCount = audioJob?.items.filter((i) => i.status === "done").length ?? 0;

  return (
    <div className="app-shell">
      {/* ==================== SIDEBAR ==================== */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h2 className="brand-title">
            <span>⚡</span> Nacht Checker
          </h2>
          <p className="brand-subtitle">Media Transcoder & Quality Toolkit</p>
        </div>

        <nav className="sidebar-nav" aria-label="Menu navigasi">
          <button
            type="button"
            className={`nav-btn ${activeMenu === "audio" ? "active" : ""}`}
            onClick={() => setActiveMenu("audio")}
          >
            <span className="nav-icon">🎵</span>
            <div className="nav-text">
              <span className="nav-title">Audio Normalizer</span>
              <span className="nav-desc">Standarisasi Sample Rate, Stereo & Codec</span>
            </div>
          </button>

          <button
            type="button"
            className={`nav-btn ${activeMenu === "video" ? "active" : ""}`}
            onClick={() => setActiveMenu("video")}
          >
            <span className="nav-icon">🎬</span>
            <div className="nav-text">
              <span className="nav-title">Video CBR Checker</span>
              <span className="nav-desc">Cek Bitrate (VBR/CBR) & Ubah ke CBR</span>
            </div>
          </button>
        </nav>

        <div className="sidebar-footer">
          <div className="status-pill">
            <span className="status-dot"></span>
            <span>FFmpeg 6.1 Ready</span>
          </div>
          <div style={{ marginTop: 4, color: "#64748b" }}>Local Processing</div>
        </div>
      </aside>

      {/* ==================== MAIN CONTENT AREA ==================== */}
      <div className="main-content">
        {/* ==================== MENU 1: AUDIO NORMALIZER ==================== */}
        {activeMenu === "audio" && (
          <main className="wrap">
            <h1>Standarisasi & Normalisasi Audio Masal</h1>
            <p className="lede">
              Samakan <strong>Sample Rate</strong> (misal 48.000 Hz), <strong>Channel Layout</strong> (wajib Stereo
              2-channel, tanpa Mono), dan <strong>Format Codec</strong> (semua AAC / MP3 / WAV) agar seluruh file
              memiliki audio yang seragam tanpa selisih atau audio drift.
            </p>

            {/* Preset 1-Klik Cepat */}
            <div className="presets-box">
              <span className="presets-box-label">Preset Cepat:</span>
              <button
                type="button"
                className="preset-btn"
                onClick={() => applyAudioPreset(48000, 2, "aac", "192")}
                title="Standar Industri Broadcast, Streaming, dan Video YouTube"
              >
                🌟 Standar Video & Broadcast (48 kHz · Stereo · AAC 192k)
              </button>
              <button
                type="button"
                className="preset-btn"
                onClick={() => applyAudioPreset(44100, 2, "mp3", "320")}
                title="Standar Musik & Podcast"
              >
                🎧 Musik / Podcast (44.1 kHz · Stereo · MP3 320k)
              </button>
              <button
                type="button"
                className="preset-btn"
                onClick={() => applyAudioPreset(48000, 2, "wav", "192")}
                title="Uncompressed PCM WAV untuk editing timeline Premiere/Resolve"
              >
                🎙️ Lossless Timeline Editing (48 kHz · Stereo · WAV)
              </button>
            </div>

            <section className="source">
              <label className="field">
                <span>Folder atau file media (video atau audio)</span>
                <input
                  type="text"
                  value={audioDir}
                  onChange={(e) => setAudioDir(e.target.value)}
                  placeholder="Contoh: D:\Footage atau D:\AudioFiles"
                  onKeyDown={(e) => e.key === "Enter" && audioDir && scanAudio()}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={audioRecursive}
                  onChange={(e) => setAudioRecursive(e.target.checked)}
                />
                Termasuk subfolder
              </label>
              <button onClick={scanAudio} disabled={!audioDir.trim() || audioScanning}>
                {audioScanning ? "Memeriksa Audio…" : "Cek Audio"}
              </button>
            </section>
            {audioScanErr && (
              <p className="error" role="alert">
                {audioScanErr}
              </p>
            )}

            {/* Rangkuman Statistik Audio */}
            {audioStats.totalDone > 0 && (
              <div className="summary-card">
                <div>
                  <strong>Deteksi Variasi Audio:</strong>{" "}
                  <span className="count">
                    {audioStats.rates.length} sample rate · {audioStats.channels.length} channel layout ·{" "}
                    {audioStats.codecs.length} codec
                  </span>
                </div>
                <div className="summary-pills">
                  {audioStats.rates.map(([sr, count]) => (
                    <span
                      key={sr}
                      className={`sr-pill ${sr === targetSampleRate ? "active-target" : "diff-target"}`}
                    >
                      {fmtSampleRate(sr)}: <strong>{count} file</strong>
                    </span>
                  ))}
                  {audioStats.channels.map(([ch, count]) => (
                    <span
                      key={ch}
                      className={`sr-pill ${ch === "Stereo" ? "active-target" : "diff-target"}`}
                    >
                      {ch}: <strong>{count} file</strong>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Peringatan jika ada ketidaksesuaian */}
            {audioStats.hasMismatch && (
              <div className="alert-banner">
                <div>
                  ⚠️ <strong>Ditemukan Perbedaan Format Audio:</strong> Terdapat file yang sample rate-nya belum{" "}
                  {fmtSampleRate(targetSampleRate)}
                  {audioStats.monoCount > 0 ? `, dan ${audioStats.monoCount} file berformat Mono` : ""}.
                </div>
                <button
                  className="ghost"
                  style={{ fontSize: 13, padding: "4px 10px" }}
                  onClick={() =>
                    setAudioSelected(
                      new Set(
                        audioRows
                          .filter(
                            (r) =>
                              !!r.a &&
                              r.a.hasAudio &&
                              (r.a.audioSampleRate !== targetSampleRate ||
                                r.a.audioChannels !== 2 ||
                                r.a.audioCodec?.toLowerCase() !== targetFormat.toLowerCase())
                          )
                          .map((r) => r.path)
                      )
                    )
                  }
                >
                  Pilih file yang belum standar
                </button>
              </div>
            )}

            {audioRows.length > 0 && (
              <>
                <div className="toolbar">
                  <h2>{audioRows.length} File Media</h2>
                  <span className="count">
                    {audioSelected.size} dipilih
                    {audioStats.monoCount ? ` · ${audioStats.monoCount} file Mono` : ""}
                    {audioStats.nonTargetSrCount
                      ? ` · ${audioStats.nonTargetSrCount} beda sample rate (${fmtSampleRate(targetSampleRate)})`
                      : ""}
                  </span>
                  <span className="spacer" />
                  <button
                    className="ghost"
                    onClick={() => setAudioSelected(new Set(audioRows.map((r) => r.path)))}
                  >
                    Pilih semua
                  </button>
                  <button
                    className="ghost"
                    onClick={() =>
                      setAudioSelected(
                        new Set(
                          audioRows
                            .filter(
                              (r) =>
                                !!r.a &&
                                r.a.hasAudio &&
                                (r.a.audioSampleRate !== targetSampleRate ||
                                  r.a.audioChannels !== 2 ||
                                  r.a.audioCodec?.toLowerCase() !== targetFormat.toLowerCase())
                            )
                            .map((r) => r.path)
                        )
                      )
                    }
                  >
                    Pilih yang belum standar
                  </button>
                  {audioStats.monoCount > 0 && (
                    <button
                      className="ghost"
                      onClick={() =>
                        setAudioSelected(
                          new Set(
                            audioRows
                              .filter((r) => !!r.a && r.a.hasAudio && r.a.audioChannels === 1)
                              .map((r) => r.path)
                          )
                        )
                      }
                    >
                      Pilih yang Mono saja
                    </button>
                  )}
                  <button className="ghost" onClick={() => setAudioSelected(new Set())}>
                    Kosongkan
                  </button>
                </div>

                <div className="tablebox">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 36 }}></th>
                        <th>File Media</th>
                        <th>Sample Rate</th>
                        <th>Channel Layout</th>
                        <th>Format Codec</th>
                        <th>Durasi</th>
                        <th className="num">Ukuran</th>
                        <th>Status Konversi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audioRows.map((r) => {
                        const [d, n] = splitPath(r.path);
                        const ji = audioJobMap.get(r.path);
                        const isAudio = r.kind === "audio" || (r.a && !r.a.hasVideo);
                        const sr = r.a?.audioSampleRate ?? null;
                        const isSrMatch = sr === targetSampleRate;
                        const isStereo = r.a?.audioChannels === 2;
                        const isCodecMatch = r.a?.audioCodec?.toLowerCase() === targetFormat.toLowerCase();

                        return (
                          <tr key={r.path}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Pilih ${n}`}
                                checked={audioSelected.has(r.path)}
                                onChange={() =>
                                  setAudioSelected((s) => {
                                    const nSet = new Set(s);
                                    nSet.has(r.path) ? nSet.delete(r.path) : nSet.add(r.path);
                                    return nSet;
                                  })
                                }
                                disabled={audioRunning}
                              />
                            </td>
                            <td>
                              <div className="fname">
                                <span className={`badge-kind ${isAudio ? "audio" : "video"}`}>
                                  {isAudio ? "Audio" : "Video"}
                                </span>
                                {n}
                              </div>
                              <div className="fdir">{d}</div>
                            </td>

                            {r.state === "done" && r.a ? (
                              <>
                                {/* Sample Rate */}
                                <td>
                                  {r.a.hasAudio && sr ? (
                                    <span className={`badge-sr ${isSrMatch ? "match" : "diff"}`}>
                                      {fmtSampleRate(sr)}
                                    </span>
                                  ) : (
                                    <span className="badge-sr none">Tanpa Audio</span>
                                  )}
                                </td>

                                {/* Channel Layout */}
                                <td>
                                  {r.a.hasAudio ? (
                                    <span
                                      className={`badge-channel ${
                                        isStereo ? "stereo" : r.a.audioChannels === 1 ? "mono" : "other"
                                      }`}
                                    >
                                      {isStereo
                                        ? "Stereo 2.0"
                                        : r.a.audioChannels === 1
                                        ? "Mono 1.0 ⚠️"
                                        : `${r.a.audioChannels || 0} Channel`}
                                    </span>
                                  ) : (
                                    <span className="sub">–</span>
                                  )}
                                </td>

                                {/* Format Codec */}
                                <td>
                                  {r.a.hasAudio ? (
                                    <>
                                      <strong className={isCodecMatch ? "" : "st-error"}>
                                        {(r.a.audioCodec || "audio").toUpperCase()}
                                      </strong>
                                      <div className="sub">
                                        {r.a.audioKbps ? `${r.a.audioKbps} kbps` : "lossless"}
                                      </div>
                                    </>
                                  ) : (
                                    <span className="sub">–</span>
                                  )}
                                </td>

                                {/* Durasi */}
                                <td>{fmtDur(r.a.duration)}</td>
                              </>
                            ) : (
                              <td colSpan={4} className={r.state === "error" ? "st-error" : "pulse"}>
                                {r.state === "error"
                                  ? r.error
                                  : r.state === "loading"
                                  ? "Menganalisis audio…"
                                  : "Menunggu giliran"}
                              </td>
                            )}

                            <td className="num">{fmtSize(r.size)}</td>

                            {/* Status Konversi */}
                            <td>
                              {ji ? (
                                ji.status === "running" ? (
                                  <div
                                    className="bar"
                                    role="progressbar"
                                    aria-valuenow={Math.round(ji.progress * 100)}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                  >
                                    <i style={{ width: `${ji.progress * 100}%` }} />
                                  </div>
                                ) : ji.status === "done" ? (
                                  <span className="st-done">Selesai</span>
                                ) : ji.status === "queued" ? (
                                  <span className="pulse">Antre</span>
                                ) : (
                                  <span className="st-error">
                                    {ji.status === "skipped" ? "Dilewati" : "Gagal"}
                                    {ji.error ? `: ${ji.error}` : ""}
                                  </span>
                                )
                              ) : (
                                <span className="sub">–</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {audioRows.length === 0 && !audioScanning && (
              <div className="empty tablebox" style={{ marginTop: 26 }}>
                Belum ada media yang discan. Masukkan path folder atau file audio/video di atas lalu klik “Cek Audio”.
              </div>
            )}

            {/* DOCK STANDARISASI AUDIO */}
            <section className="dock" aria-label="Pengaturan standarisasi audio masal">
              <div className="dock-in">
                <div className="opts">
                  <label className="field">
                    <span>Target Sample Rate</span>
                    <select
                      value={targetSampleRate}
                      onChange={(e) => setTargetSampleRate(Number(e.target.value))}
                      disabled={audioRunning}
                    >
                      <option value={48000}>48.000 Hz (48 kHz) - Standar Video/Broadcast</option>
                      <option value={44100}>44.100 Hz (44.1 kHz) - Standar Audio/CD/Musik</option>
                      <option value={96000}>96.000 Hz (96 kHz) - Hi-Res Audio</option>
                      <option value={32000}>32.000 Hz (32 kHz)</option>
                    </select>
                  </label>

                  <label className="field">
                    <span>Target Channel Layout</span>
                    <select
                      value={targetChannels}
                      onChange={(e) => setTargetChannels(Number(e.target.value))}
                      disabled={audioRunning}
                    >
                      <option value={2}>Wajib Stereo (2-Channel) - Mono jadi Stereo</option>
                      <option value={1}>Mono (1-Channel)</option>
                    </select>
                  </label>

                  <label className="field">
                    <span>Target Format Codec</span>
                    <select
                      value={targetFormat}
                      onChange={(e) => setTargetFormat(e.target.value as any)}
                      disabled={audioRunning}
                    >
                      <option value="aac">AAC (Direkomendasikan untuk MP4 & Video)</option>
                      <option value="mp3">MP3</option>
                      <option value="wav">WAV (PCM 16-bit Uncompressed)</option>
                      <option value="flac">FLAC (Lossless)</option>
                    </select>
                  </label>

                  <label className="field">
                    <span>Bitrate Audio</span>
                    <select
                      value={targetAudioKbps}
                      onChange={(e) => setTargetAudioKbps(e.target.value)}
                      disabled={audioRunning || targetFormat === "wav" || targetFormat === "flac"}
                    >
                      <option value="128">128 kbps</option>
                      <option value="192">192 kbps (Standar)</option>
                      <option value="256">256 kbps (Tinggi)</option>
                      <option value="320">320 kbps (Maksimum)</option>
                    </select>
                  </label>

                  <label className="field">
                    <span>Penanganan Video</span>
                    <select
                      value={audioAction}
                      onChange={(e) => setAudioAction(e.target.value as any)}
                      disabled={audioRunning}
                    >
                      <option value="audio_norm_fast">⚡ Salin Video Langsung (Copy - Super Cepat)</option>
                      <option value="audio_only">🎵 Buat File Audio Saja (Ekstrak suara)</option>
                    </select>
                  </label>

                  <label className="field">
                    <span>Akhiran Nama File</span>
                    <input
                      type="text"
                      value={audioSuffix}
                      onChange={(e) => setAudioSuffix(e.target.value)}
                      disabled={audioRunning}
                    />
                  </label>

                  <label className="field wide">
                    <span>Folder Output (kosong = subfolder normalized_output)</span>
                    <input
                      type="text"
                      value={audioOutDir}
                      onChange={(e) => setAudioOutDir(e.target.value)}
                      placeholder="Folder tujuan konversi"
                      disabled={audioRunning}
                    />
                  </label>
                </div>

                <div className="dock-actions">
                  <button onClick={convertAudio} disabled={!audioSelected.size || audioRunning}>
                    {audioRunning
                      ? "Sedang Menstandarkan Audio…"
                      : `⚡ Standarisasikan ${audioSelected.size || ""} File (Wajib ${
                          targetSampleRate / 1000
                        } kHz · Stereo · ${targetFormat.toUpperCase()})`}
                  </button>
                  {audioRunning && (
                    <button className="ghost" onClick={cancelAudio}>
                      Batalkan
                    </button>
                  )}
                  <label className="check" style={{ paddingBottom: 0 }}>
                    <input
                      type="checkbox"
                      checked={audioOverwrite}
                      onChange={(e) => setAudioOverwrite(e.target.checked)}
                      disabled={audioRunning}
                    />
                    Timpa file output jika sudah ada
                  </label>
                  <span className="spacer" />
                  {audioJob && (
                    <span className="hint">
                      {audioDoneCount}/{audioJob.items.length} selesai
                      {audioJob.status === "cancelled" ? " (dibatalkan)" : ""}
                    </span>
                  )}
                  {audioConvErr && (
                    <span className="error" role="alert" style={{ margin: 0 }}>
                      {audioConvErr}
                    </span>
                  )}
                </div>
                <p className="hint" style={{ margin: "8px 0 0" }}>
                  💡 Semua file yang diproses akan dijamin memiliki Sample Rate sama ({targetSampleRate} Hz), Channel
                  Stereo 2.0 (Mono otomatis diduplikasi ke L & R), dan format codec yang sama ({targetFormat.toUpperCase()}
                  ).
                </p>
              </div>
            </section>
          </main>
        )}

        {/* ==================== MENU 2: VIDEO CBR CHECKER ==================== */}
        {activeMenu === "video" && (
          <main className="wrap">
            <h1>Cek Bitrate Video & Ubah ke CBR</h1>
            <p className="lede">
              Periksa kestabilan bitrate per detik pada file video untuk mendeteksi apakah VBR atau CBR. Ubah video ke
              format CBR secara masal dengan bitrate konstan pilihanmu.
            </p>

            <section className="source">
              <label className="field">
                <span>Folder atau file video</span>
                <input
                  type="text"
                  value={videoDir}
                  onChange={(e) => setVideoDir(e.target.value)}
                  placeholder="/home/user/videos atau D:\Videos"
                  onKeyDown={(e) => e.key === "Enter" && videoDir && scanVideo()}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={videoRecursive}
                  onChange={(e) => setVideoRecursive(e.target.checked)}
                />
                Termasuk subfolder
              </label>
              <button onClick={scanVideo} disabled={!videoDir.trim() || videoScanning}>
                {videoScanning ? "Memeriksa…" : "Cek Video"}
              </button>
            </section>
            {videoScanErr && (
              <p className="error" role="alert">
                {videoScanErr}
              </p>
            )}

            {videoRows.length > 0 && (
              <>
                <div className="toolbar">
                  <h2>{videoRows.length} File Video</h2>
                  <span className="count">
                    {videoSelected.size} dipilih{videoVbrCount ? `, ${videoVbrCount} bukan CBR` : ""}
                  </span>
                  <span className="spacer" />
                  <button
                    className="ghost"
                    onClick={() => setVideoSelected(new Set(videoRows.map((r) => r.path)))}
                  >
                    Pilih semua
                  </button>
                  <button
                    className="ghost"
                    onClick={() =>
                      setVideoSelected(new Set(videoRows.filter((r) => !!r.a && r.a.verdict !== "CBR").map((r) => r.path)))
                    }
                  >
                    Pilih yang bukan CBR
                  </button>
                  <button className="ghost" onClick={() => setVideoSelected(new Set())}>
                    Kosongkan
                  </button>
                </div>

                <div className="tablebox">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 36 }}></th>
                        <th>File Video</th>
                        <th>Bitrate per detik</th>
                        <th>Tipe</th>
                        <th className="num">Bitrate Video</th>
                        <th>Format & Resolusi</th>
                        <th className="num">Ukuran</th>
                        <th>Konversi CBR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {videoRows.map((r) => {
                        const [d, n] = splitPath(r.path);
                        const ji = videoJobMap.get(r.path);

                        return (
                          <tr key={r.path}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Pilih ${n}`}
                                checked={videoSelected.has(r.path)}
                                onChange={() =>
                                  setVideoSelected((s) => {
                                    const nSet = new Set(s);
                                    nSet.has(r.path) ? nSet.delete(r.path) : nSet.add(r.path);
                                    return nSet;
                                  })
                                }
                                disabled={videoRunning}
                              />
                            </td>
                            <td>
                              <div className="fname">{n}</div>
                              <div className="fdir">{d}</div>
                            </td>

                            {r.state === "done" && r.a ? (
                              <>
                                <td
                                  style={{
                                    color: `var(--${
                                      r.a.verdict === "CBR"
                                        ? "cbr"
                                        : r.a.verdict === "NEAR_CBR"
                                        ? "near"
                                        : r.a.verdict === "VBR"
                                        ? "vbr"
                                        : "muted"
                                    })`,
                                  }}
                                >
                                  <Sparkline series={r.a.series} kbps={r.a.videoKbps} />
                                </td>
                                <td>
                                  <span className={`badge ${r.a.verdict}`}>{LABEL[r.a.verdict]}</span>
                                  <div className="sub">variasi {(r.a.cv * 100).toFixed(1)}%</div>
                                </td>
                                <td className="num">
                                  <strong>{r.a.videoKbps.toLocaleString("id-ID")}</strong> kbps
                                  <div className="sub">
                                    {r.a.minKbps}–{r.a.maxKbps}
                                  </div>
                                </td>
                                <td>
                                  {r.a.codec.toUpperCase()}
                                  <div className="sub">
                                    {r.a.width}×{r.a.height} · {r.a.fps.toFixed(2)} fps · {fmtDur(r.a.duration)}
                                  </div>
                                </td>
                              </>
                            ) : (
                              <td colSpan={4} className={r.state === "error" ? "st-error" : "pulse"}>
                                {r.state === "error"
                                  ? r.error
                                  : r.state === "loading"
                                  ? "Menganalisis bitrate video…"
                                  : "Menunggu giliran"}
                              </td>
                            )}

                            <td className="num">{fmtSize(r.size)}</td>

                            <td>
                              {ji ? (
                                ji.status === "running" ? (
                                  <div
                                    className="bar"
                                    role="progressbar"
                                    aria-valuenow={Math.round(ji.progress * 100)}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                  >
                                    <i style={{ width: `${ji.progress * 100}%` }} />
                                  </div>
                                ) : ji.status === "done" ? (
                                  <span className="st-done">Selesai</span>
                                ) : ji.status === "queued" ? (
                                  <span className="pulse">Antre</span>
                                ) : (
                                  <span className="st-error">
                                    {ji.status === "skipped" ? "Dilewati" : "Gagal"}
                                    {ji.error ? `: ${ji.error}` : ""}
                                  </span>
                                )
                              ) : (
                                <span className="sub">–</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {videoRows.length === 0 && !videoScanning && (
              <div className="empty tablebox" style={{ marginTop: 26 }}>
                Belum ada video. Masukkan path folder video di atas lalu klik “Cek Video”.
              </div>
            )}

            {/* DOCK KONVERSI CBR */}
            <section className="dock" aria-label="Pengaturan konversi CBR">
              <div className="dock-in">
                <div className="opts">
                  <label className="field">
                    <span>Bitrate video CBR (kbps)</span>
                    <input
                      type="number"
                      min={100}
                      max={100000}
                      step={100}
                      value={videoCbrKbps}
                      onChange={(e) => setVideoCbrKbps(e.target.value)}
                      disabled={videoRunning}
                    />
                  </label>
                  <label className="field">
                    <span>Audio</span>
                    <select
                      value={videoAudioMode}
                      onChange={(e) => setVideoAudioMode(e.target.value as "aac" | "copy")}
                      disabled={videoRunning}
                    >
                      <option value="aac">Encode AAC</option>
                      <option value="copy">Salin asli</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Bitrate audio (kbps)</span>
                    <input
                      type="number"
                      min={32}
                      max={512}
                      step={16}
                      value={videoAudioKbps}
                      onChange={(e) => setVideoAudioKbps(e.target.value)}
                      disabled={videoRunning || videoAudioMode === "copy"}
                    />
                  </label>
                  <label className="field">
                    <span>Kecepatan encode</span>
                    <select
                      value={videoPreset}
                      onChange={(e) => setVideoPreset(e.target.value)}
                      disabled={videoRunning}
                    >
                      {["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Format output</span>
                    <select
                      value={videoContainer}
                      onChange={(e) => setVideoContainer(e.target.value)}
                      disabled={videoRunning}
                    >
                      {["mp4", "mkv", "flv", "ts"].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Akhiran nama file</span>
                    <input
                      type="text"
                      value={videoSuffix}
                      onChange={(e) => setVideoSuffix(e.target.value)}
                      disabled={videoRunning}
                    />
                  </label>
                  <label className="field wide">
                    <span>Folder output (kosong = subfolder cbr_output)</span>
                    <input
                      type="text"
                      value={videoOutDir}
                      onChange={(e) => setVideoOutDir(e.target.value)}
                      disabled={videoRunning}
                    />
                  </label>
                </div>

                <div className="dock-actions">
                  <button onClick={convertVideo} disabled={!videoSelected.size || videoRunning}>
                    {videoRunning
                      ? "Mengonversi…"
                      : `🎬 Ubah ${videoSelected.size || ""} File ke CBR ${Number(videoCbrKbps) || ""} kbps`}
                  </button>
                  {videoRunning && (
                    <button className="ghost" onClick={cancelVideo}>
                      Batalkan
                    </button>
                  )}
                  <label className="check" style={{ paddingBottom: 0 }}>
                    <input
                      type="checkbox"
                      checked={videoOverwrite}
                      onChange={(e) => setVideoOverwrite(e.target.checked)}
                      disabled={videoRunning}
                    />
                    Timpa file output yang sudah ada
                  </label>
                  <span className="spacer" />
                  {videoJob && (
                    <span className="hint">
                      {videoDoneCount}/{videoJob.items.length} selesai
                      {videoJob.status === "cancelled" ? " (dibatalkan)" : ""}
                    </span>
                  )}
                  {videoConvErr && (
                    <span className="error" role="alert" style={{ margin: 0 }}>
                      {videoConvErr}
                    </span>
                  )}
                </div>
                <p className="hint" style={{ margin: "8px 0 0" }}>
                  File asli tidak diubah; hasil disimpan sebagai file baru di folder output.
                </p>
              </div>
            </section>
          </main>
        )}
      </div>
    </div>
  );
}

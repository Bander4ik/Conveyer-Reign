"use client";
import { useEffect, useRef, useState, use } from "react";

interface LogEntry {
  id?: number;
  ts: string;
  level: "info" | "warn" | "error" | "success" | "debug";
  stage?: string;
  message: string;
  data?: unknown;
}
interface Run {
  id: string;
  title: string | null;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  output_path: string | null;
  config_json?: string | null;
}

/** Snapshot of what the run was configured to generate, written at creation. */
interface GenerationPlan {
  channelName: string | null;
  clipsSource: "none" | "ai" | "stock";
  clipsRatio: number;
  stillsSource: "ai" | "stock";
  realSubjects: boolean;
  voiceover: boolean;
  keepClipAudio: boolean;
  battleCard: boolean;
  imageModel: string;
  animationModel: string;
  voice: string;
  characters: number;
  imageProvider?: string;
  animationProvider?: string;
  ttsProvider?: string;
}

function parsePlan(run: Run | null): GenerationPlan | null {
  if (!run?.config_json) return null;
  try {
    const cfg = JSON.parse(run.config_json) as { generation?: GenerationPlan };
    return cfg.generation ?? null;
  } catch {
    return null;
  }
}
interface SceneAsset {
  index: number;
  audio?: { name: string; size: number };
  image?: { name: string; size: number };
  animation?: { name: string; size: number };
  clip?: { name: string; size: number };
}
interface AssetsResponse {
  runDir: string;
  scenes: SceneAsset[];
  finalExists: boolean;
  finalSize: number;
}

// Sliding window cap on the visible log buffer. A 1 000+ scene run can
// generate 10 000+ log rows; keeping every single one in React state pegs the
// browser (DOM rendering + reconciliation on each new SSE event). 500 is
// enough for the live-activity feed; the full history lives in run_logs.
const LOG_DISPLAY_CAP = 500;

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [assets, setAssets] = useState<AssetsResponse | null>(null);
  const [reassembling, setReassembling] = useState(false);
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/runs/${id}/logs`);
    es.addEventListener("log", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data) as LogEntry;
      setLogs((prev) => {
        const next = [...prev, e];
        return next.length > LOG_DISPLAY_CAP ? next.slice(-LOG_DISPLAY_CAP) : next;
      });
    });
    return () => es.close();
  }, [id]);

  useEffect(() => {
    let alive = true;
    async function tick() {
      const [runR, assetsR] = await Promise.all([
        fetch(`/api/runs/${id}`).then((r) => r.json()),
        fetch(`/api/runs/${id}/assets`).then((r) => r.json()),
      ]);
      if (!alive) return;
      setRun(runR.run as Run);
      setAssets(assetsR as AssetsResponse);
    }
    tick();
    const t = setInterval(tick, 2500);
    return () => { alive = false; clearInterval(t); };
  }, [id]);

  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  async function reassemble() {
    setReassembling(true);
    try {
      await fetch(`/api/runs/${id}/reassemble`, { method: "POST" });
    } finally {
      setReassembling(false);
    }
  }

  async function cancel() {
    if (!confirm("Stop this run? Already generated files stay on disk, but no new progress will be made.")) return;
    await fetch(`/api/runs/${id}/cancel`, { method: "POST" });
  }

  async function openFolder() {
    try {
      const r = await fetch(`/api/runs/${id}/open-folder`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) {
        alert(`Failed to open folder: ${j.error}\n\nPath: ${j.runDir || ""}`);
        return;
      }
    } catch (e) {
      alert(`Error: ${(e as Error).message}`);
    }
  }

  const fileUrl = (p: string, dl = false) => `/api/runs/${id}/file?p=${encodeURIComponent(p)}${dl ? "&download=1" : ""}`;

  const plan = parsePlan(run);
  const planRows: { label: string; value: string }[] = plan
    ? [
        {
          label: "Moving clips",
          value:
            plan.clipsSource === "none"
              ? "none — still images only"
              : plan.clipsSource === "stock"
                ? `${plan.clipsRatio}% of scenes — real stock footage (Pexels)`
                : `${plan.clipsRatio}% of scenes — AI video (${plan.animationModel}${plan.animationProvider ? ` via ${plan.animationProvider}` : ""})`,
        },
        {
          label: "Still images",
          value:
            plan.stillsSource === "stock"
              ? "real stock photos (Pexels)"
              : `AI images (${plan.imageModel}${plan.imageProvider ? ` via ${plan.imageProvider}` : ""})`,
        },
        ...(plan.realSubjects
          ? [{ label: "Real subjects", value: "real photos from Wikipedia for named people/places" }]
          : []),
        {
          label: "Audio",
          value: plan.voiceover
            ? `AI voiceover (${plan.voice}${plan.ttsProvider ? ` via ${plan.ttsProvider}` : ""})`
            : plan.keepClipAudio
              ? "no voiceover — clips' own sound"
              : "no voiceover — silent",
        },
        ...(plan.battleCard ? [{ label: "Extras", value: 'intro "VS" stat card' }] : []),
        ...(plan.characters > 0
          ? [{ label: "Characters", value: `${plan.characters} recurring character${plan.characters === 1 ? "" : "s"}` }]
          : []),
        { label: "Channel", value: plan.channelName ?? "none — global settings" },
      ]
    : [];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800 }}>{run?.title || `Run ${id.slice(0, 8)}`}</h1>
          <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>{id}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {(run?.status === "running" || run?.status === "pending") && (
            <button className="btn-secondary" onClick={cancel} style={{ color: "var(--danger)", borderColor: "#3a1d1d" }}>
              ⏹ Stop
            </button>
          )}
          {run && <span className={`tag tag-${run.status}`}>{run.status}</span>}
        </div>
      </div>

      {plan && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>🎛 What this run generates</div>
          <div style={{ display: "grid", gridTemplateColumns: "130px 1fr", rowGap: 6, columnGap: 12, fontSize: 13 }}>
            {planRows.map((r) => (
              <div key={r.label} style={{ display: "contents" }}>
                <div style={{ color: "var(--fg-muted)", fontWeight: 600 }}>{r.label}</div>
                <div>{r.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {assets?.finalExists && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 700 }}>🎬 Final video</div>
              <div style={{ color: "var(--fg-muted)", fontSize: 12 }}>
                {(assets.finalSize / (1024 * 1024)).toFixed(2)} MB
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <a className="btn" href={fileUrl("final.mp4", true)}>⬇ Download MP4</a>
              <button className="btn-secondary" onClick={openFolder}>📁 Open folder</button>
            </div>
          </div>
          <video
            controls
            style={{ width: "100%", maxHeight: 480, borderRadius: 8, background: "#000" }}
            src={fileUrl("final.mp4")}
          />
        </div>
      )}

      {run?.status === "error" && assets && assets.scenes.length > 0 && !assets.finalExists && (
        <div className="card" style={{ marginBottom: 12, borderColor: "#3a1d1d" }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>⚠️ Pipeline failed, but assets are saved</div>
          <p style={{ color: "var(--fg-muted)", fontSize: 13, marginBottom: 10 }}>
            {assets.scenes.length} scenes already have audio + images on disk. You can fill any gaps and reassemble the final video without re-running the whole pipeline.
          </p>
          <p style={{ color: "var(--fg-muted)", fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
            <strong>Note:</strong> reassemble reuses this run&apos;s scenes exactly as they were first
            split — it keeps the <em>original</em> prompt and will <em>not</em> apply a prompt you changed
            afterwards. To generate with a new or edited prompt, start a <strong>New run</strong> instead.
          </p>
          <button className="btn" onClick={reassemble} disabled={reassembling}>
            {reassembling ? "Reassembling..." : "🔁 Reassemble from existing assets"}
          </button>
        </div>
      )}

      <div className="card" style={{ marginBottom: 12, background: "var(--bg-deep)", maxHeight: 420, overflowY: "auto", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6, fontFamily: "inherit", fontSize: 13 }}>Logs</div>
        {logs.length === 0 && <div style={{ color: "var(--fg-muted)" }}>Waiting for logs…</div>}
        {logs.map((l, i) => (
          <div key={l.id ?? i} style={{ padding: "2px 0" }}>
            <span style={{ color: "var(--fg-faint)" }}>{new Date(l.ts).toLocaleTimeString()}</span>{" "}
            {l.stage && <span style={{ color: "var(--accent)" }}>[{l.stage}]</span>}{" "}
            <span style={{ color: levelColor(l.level) }}>{l.level.toUpperCase()}</span>{" "}
            <span>{l.message}</span>
          </div>
        ))}
        <div ref={tail} />
      </div>

      {assets && assets.scenes.length > 0 && (
        <div className="card">
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Scene assets ({assets.scenes.length})</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
            {assets.scenes.map((s) => (
              <div key={s.index} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 8, background: "var(--field)" }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Scene #{s.index}</div>
                {s.image && (
                  <a href={fileUrl(`images/${s.image.name}`, true)} title="Download image">
                    <img
                      src={fileUrl(`images/${s.image.name}`)}
                      alt={`scene ${s.index}`}
                      style={{ width: "100%", borderRadius: 6, display: "block" }}
                    />
                  </a>
                )}
                {s.audio && (
                  <audio controls src={fileUrl(`audio/${s.audio.name}`)} style={{ width: "100%", marginTop: 6 }} />
                )}
                <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap", fontSize: 11 }}>
                  {s.image && <a href={fileUrl(`images/${s.image.name}`, true)} className="btn-secondary" style={{ fontSize: 11, padding: "3px 6px" }}>img</a>}
                  {s.audio && <a href={fileUrl(`audio/${s.audio.name}`, true)} className="btn-secondary" style={{ fontSize: 11, padding: "3px 6px" }}>mp3</a>}
                  {s.animation && <a href={fileUrl(`animations/${s.animation.name}`, true)} className="btn-secondary" style={{ fontSize: 11, padding: "3px 6px" }}>anim</a>}
                  {s.clip && <a href={fileUrl(`clips/${s.clip.name}`, true)} className="btn-secondary" style={{ fontSize: 11, padding: "3px 6px" }}>clip</a>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function levelColor(l: LogEntry["level"]) {
  switch (l) {
    case "error": return "var(--danger)";
    case "warn": return "var(--warning)";
    case "success": return "var(--success)";
    case "debug": return "var(--fg-muted)";
    default: return "var(--fg)";
  }
}

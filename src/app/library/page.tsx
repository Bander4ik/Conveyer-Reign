"use client";
import { useEffect, useMemo, useState } from "react";

interface LibraryClip {
  index: number;
  file: string;
  drive_file_id: string;
  drive_file_link: string;
  scene_text: string;
  visual_prompt: string;
  duration_hint_sec: number;
  audio_duration_sec: number | null;
}

interface LibraryRun {
  drive_folder_id: string;
  drive_folder_name: string;
  drive_folder_link: string;
  run_id: string;
  run_title: string | null;
  folder_name: string;
  created_at: string;
  scene_count: number;
  uploaded_clip_count: number;
  settings: {
    animation_provider: string;
    animation_model: string;
    video_resolution: string;
  };
  clips: LibraryClip[];
}

interface GdriveStatus {
  connected: boolean;
  credentialsConfigured: boolean;
}

export default function LibraryPage() {
  const [runs, setRuns] = useState<LibraryRun[] | null>(null);
  const [drive, setDrive] = useState<GdriveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const driveR = await fetch("/api/gdrive/status").then((r) => r.json());
        if (!alive) return;
        setDrive(driveR as GdriveStatus);
        if (!driveR.connected) {
          setRuns([]);
          return;
        }
        const r = await fetch("/api/library/runs").then((r) => r.json());
        if (!alive) return;
        if (r.error) {
          setError(String(r.error));
          setRuns([]);
        } else {
          setRuns((r.runs ?? []) as LibraryRun[]);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!runs) return [];
    const q = query.trim().toLowerCase();
    if (!q) return runs;
    return runs.filter((r) => {
      const inTitle = (r.run_title || r.folder_name).toLowerCase().includes(q);
      const inClips = r.clips.some(
        (c) =>
          c.scene_text.toLowerCase().includes(q) ||
          c.visual_prompt.toLowerCase().includes(q)
      );
      return inTitle || inClips;
    });
  }, [runs, query]);

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>Library</h1>
      <p style={{ color: "#8a8aa0", marginBottom: 16, lineHeight: 1.6 }}>
        Every run you've saved to Google Drive. AI uses this library to find clips it can reuse
        when you start a new run with similar scenes.
      </p>

      {loading && <div style={{ color: "#8a8aa0" }}>Loading…</div>}

      {!loading && drive && !drive.connected && (
        <div className="card" style={{ borderColor: "#3a3a4a" }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6, color: "#ffce4d" }}>
            ⚠ Google Drive is not connected
          </div>
          <p style={{ color: "#8a8aa0", fontSize: 13, marginBottom: 10, lineHeight: 1.5 }}>
            Connect your Google account in Settings — saved runs will appear here automatically.
          </p>
          <a className="btn" href="/settings">
            Open Settings →
          </a>
        </div>
      )}

      {!loading && drive?.connected && error && (
        <div className="card" style={{ borderColor: "#5a3a3a", marginBottom: 12 }}>
          <div style={{ color: "#ff6d6d", fontWeight: 600, fontSize: 13 }}>
            ❌ Couldn't load library
          </div>
          <div
            style={{
              color: "#9090a8",
              fontSize: 11,
              marginTop: 6,
              fontFamily: "ui-monospace, monospace",
              whiteSpace: "pre-wrap",
            }}
          >
            {error}
          </div>
        </div>
      )}

      {!loading && drive?.connected && !error && runs && runs.length === 0 && (
        <div className="card">
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>📭 Library is empty</div>
          <p style={{ color: "#8a8aa0", fontSize: 13, lineHeight: 1.5 }}>
            Run the pipeline — finished runs auto-upload to Drive (if you toggled
            "Auto-upload finished runs to Drive" in Settings). Each new run shows up here.
          </p>
        </div>
      )}

      {!loading && drive?.connected && runs && runs.length > 0 && (
        <>
          <div style={{ marginBottom: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              className="input"
              placeholder="Search by title or scene text…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ maxWidth: 380, flex: 1 }}
            />
            <span style={{ color: "#8a8aa0", fontSize: 13 }}>
              {filtered.length === runs.length
                ? `${runs.length} run${runs.length === 1 ? "" : "s"}`
                : `${filtered.length} of ${runs.length} runs`}
            </span>
          </div>

          <div style={{ display: "grid", gap: 12 }}>
            {filtered.map((r) => {
              const isOpen = openRunId === r.drive_folder_id;
              return (
                <div key={r.drive_folder_id} className="card">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
                        {r.run_title || r.folder_name}
                      </div>
                      <div style={{ color: "#8a8aa0", fontSize: 12 }}>
                        {r.created_at && (
                          <span>
                            {new Date(r.created_at).toLocaleString()} ·{" "}
                          </span>
                        )}
                        {r.uploaded_clip_count} clip{r.uploaded_clip_count === 1 ? "" : "s"}
                        {r.scene_count !== r.uploaded_clip_count && (
                          <span> / {r.scene_count} scenes</span>
                        )}
                        {r.settings.animation_model && (
                          <span>
                            {" "}· {r.settings.animation_model}{" "}
                            {r.settings.video_resolution && <>({r.settings.video_resolution})</>}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button
                        className="btn-secondary"
                        onClick={() => setOpenRunId(isOpen ? null : r.drive_folder_id)}
                        style={{ fontSize: 12 }}
                      >
                        {isOpen ? "Hide clips" : `View ${r.uploaded_clip_count} clips`}
                      </button>
                      <a
                        className="btn-secondary"
                        href={r.drive_folder_link}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: 12 }}
                      >
                        Open in Drive
                      </a>
                    </div>
                  </div>

                  {isOpen && (
                    <div
                      style={{
                        marginTop: 12,
                        paddingTop: 10,
                        borderTop: "1px solid #232334",
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                        gap: 10,
                      }}
                    >
                      {r.clips.map((c) => (
                        <div
                          key={c.drive_file_id}
                          style={{
                            background: "#0f0f17",
                            border: "1px solid #232334",
                            borderRadius: 8,
                            padding: 10,
                          }}
                        >
                          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>
                            Scene {c.index}
                            {c.audio_duration_sec != null && c.audio_duration_sec > 0 && (
                              <span style={{ color: "#8a8aa0", marginLeft: 6, fontWeight: 400 }}>
                                {c.audio_duration_sec.toFixed(1)}s audio
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              color: "#b8b8c8",
                              fontSize: 11,
                              lineHeight: 1.5,
                              marginBottom: 6,
                              maxHeight: 70,
                              overflow: "auto",
                            }}
                          >
                            {c.scene_text}
                          </div>
                          <div
                            style={{
                              color: "#7c5cff",
                              fontSize: 10,
                              fontFamily: "ui-monospace, monospace",
                              marginBottom: 8,
                              maxHeight: 70,
                              overflow: "auto",
                              lineHeight: 1.4,
                            }}
                          >
                            {c.visual_prompt}
                          </div>
                          <a
                            href={c.drive_file_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "#7c5cff", fontSize: 11 }}
                          >
                            Open clip in Drive →
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

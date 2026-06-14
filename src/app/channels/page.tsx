"use client";
import { useEffect, useState } from "react";

type ClipsSource = "none" | "ai" | "stock";
type StillsSource = "ai" | "stock";

interface Channel {
  id: string;
  name: string;
  scene_split: string;
  image_prompt: string;
  animation_motion: string;
  clips_source: ClipsSource;
  clips_ratio: number;
  stills_source: StillsSource;
  real_subjects: boolean;
  voiceover: boolean;
  keep_clip_audio: boolean;
  battle_card: boolean;
  voice_id: string;
  thumbnail: boolean;
  thumbnail_prompt: string;
}

const HELP = {
  clips:
    "Whether scenes move (video) or stay still images, and whether the moving clips are AI-generated (Veo) or REAL footage from the web (Pexels / Internet Archive…) where Gemini Vision picks the clip that best matches each scene.",
  ratio: "How many scenes become moving clips — the rest are still images.",
  stills: "How the still scenes look — AI-generated (nano-banana) or REAL photos from the web (Pexels / Openverse / Wikimedia) where Gemini Vision picks the best match per scene.",
  real:
    "When your script names a real planet / scientist / place, pull an ACTUAL photo of it from Wikipedia (overrides the choices above for those scenes).",
  voiceover:
    "Whether an AI narrator reads your script. Off = no narration — the video uses the clips' own sound if 'Keep clip sounds' is on below, otherwise it plays silent.",
  keepClipAudio:
    "When voiceover is off, use each clip's own sound — the ambient audio Veo makes on AI clips, or the real audio of stock (Pexels) clips — so the video isn't silent.",
  voice:
    "The narrator voice for THIS channel. Leave empty to use the default voice from Settings. For ElevenLabs, paste a voice id from your ElevenLabs library (e.g. G17SuINrv2H9FC6nvetn).",
  thumbnail:
    "Auto-generate YouTube thumbnail options at the end of each run. The system reads your whole script + the video title and makes a few thumbnails in your style to choose from (shown on the run page).",
  thumbnailPrompt:
    "Your MASTER thumbnail recipe — the overall look for this channel's thumbnails (subject framing, lighting, mood, space for a title…). You write it once. For each video the AI turns this + the title + the full script into a specific thumbnail prompt and generates several options.",
  battle:
    "Adds an intro “VS” stat card (e.g. weight / bite force / speed) at the start. Works on top of any visual setup.",
  sceneSplit:
    "How the LLM slices your script into scenes. It can also tag each scene's visual per scene (visual_type: real_image / person_overlay) so a real subject pulls a real photo even in an AI channel.",
};

function blank(defaults: Pick<Channel, "scene_split" | "image_prompt" | "animation_motion">): Channel {
  return {
    id: "",
    name: "",
    clips_source: "ai",
    clips_ratio: 50,
    stills_source: "ai",
    real_subjects: true,
    voiceover: true,
    keep_clip_audio: false,
    battle_card: false,
    voice_id: "",
    thumbnail: false,
    thumbnail_prompt: "",
    scene_split: defaults.scene_split,
    image_prompt: defaults.image_prompt,
    animation_motion: defaults.animation_motion,
  };
}

function summary(c: Channel): string {
  const parts: string[] = [];
  if (c.clips_source === "none") parts.push("stills only");
  else parts.push(`${c.clips_ratio}% ${c.clips_source === "stock" ? "stock" : "AI"} clips`);
  parts.push(`${c.stills_source === "stock" ? "stock" : "AI"} stills`);
  if (c.real_subjects) parts.push("real subjects");
  parts.push(c.voiceover ? "voiceover" : "no voiceover");
  if (c.battle_card) parts.push("stat card");
  return parts.join(" · ");
}

const labelStyle = { fontWeight: 600, fontSize: 13, color: "var(--fg)", marginBottom: 2, display: "block" } as const;
const helpStyle = {
  color: "var(--fg-faint)",
  fontSize: 12,
  margin: "4px 0 0",
  lineHeight: 1.45,
} as const;

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [defaults, setDefaults] = useState({ scene_split: "", image_prompt: "", animation_motion: "" });
  const [editing, setEditing] = useState<Channel | null>(null);
  const [saved, setSaved] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  async function load() {
    const [chRes, prRes] = await Promise.all([fetch("/api/channels"), fetch("/api/prompts")]);
    setChannels((await chRes.json()) as Channel[]);
    const pr = (await prRes.json()) as Record<string, string>;
    setDefaults({
      scene_split: pr.scene_split ?? "",
      image_prompt: pr.image_prompt ?? "",
      animation_motion: pr.animation_motion ?? "",
    });
  }
  useEffect(() => {
    load();
  }, []);

  function set<K extends keyof Channel>(k: K, v: Channel[K]) {
    setEditing((e) => (e ? { ...e, [k]: v } : e));
  }

  async function save() {
    if (!editing || !editing.name.trim()) {
      alert("Give the channel a name first.");
      return;
    }
    const r = await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing),
    });
    const { id } = (await r.json()) as { id: string };
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    await load();
    setEditing((e) => (e ? { ...e, id } : e));
  }

  async function remove() {
    if (!editing) return;
    if (!editing.id) {
      setEditing(null);
      return;
    }
    if (!confirm(`Delete channel "${editing.name}"?`)) return;
    await fetch(`/api/channels?id=${encodeURIComponent(editing.id)}`, { method: "DELETE" });
    setEditing(null);
    await load();
  }

  const e = editing;

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>Channels</h1>
      <p style={{ color: "var(--fg-muted)", marginBottom: 16, lineHeight: 1.6 }}>
        Save a separate setup per channel so different content never gets mixed up. Pick a channel on
        the <strong>New run</strong> page and the run uses its settings + prompts. A new channel starts
        from your global <a href="/prompts">Prompts</a> defaults.
      </p>

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* List */}
        <div className="card" style={{ width: 250, flexShrink: 0, display: "grid", gap: 10 }}>
          <button className="btn" onClick={() => setEditing(blank(defaults))}>
            + New channel
          </button>
          <div style={{ display: "grid", gap: 4 }}>
            {channels.length === 0 && (
              <p style={{ color: "var(--fg-faint)", fontSize: 13, margin: 0 }}>No channels yet.</p>
            )}
            {channels.map((c) => {
              const active = e?.id === c.id && !!c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => setEditing({ ...c })}
                  style={{
                    textAlign: "left",
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: `1px solid ${active ? "var(--border-strong)" : "transparent"}`,
                    background: active ? "var(--surface-2)" : "transparent",
                    color: "var(--fg)",
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{c.name}</span>
                  <span style={{ fontSize: 11, color: "var(--fg-faint)" }}>{summary(c)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Editor */}
        {e ? (
          <div className="card" style={{ flex: 1, minWidth: 380, display: "grid", gap: 16 }}>
            <div>
              <label style={labelStyle}>Channel name</label>
              <input
                className="input"
                value={e.name}
                placeholder="e.g. Animal Battles, Space Science"
                onChange={(ev) => set("name", ev.target.value)}
              />
            </div>

            {/* VISUALS */}
            <div style={{ display: "grid", gap: 12 }}>
              <h3 style={{ fontWeight: 700, fontSize: 13, letterSpacing: "0.02em", color: "var(--fg-muted)", textTransform: "uppercase", margin: 0 }}>
                Visuals — what each scene looks like
              </h3>

              <div>
                <label style={labelStyle}>Moving clips</label>
                <select className="input" value={e.clips_source} onChange={(ev) => set("clips_source", ev.target.value as ClipsSource)}>
                  <option value="none">None — still images only</option>
                  <option value="ai">AI-generated (Veo)</option>
                  <option value="stock">Real footage (web · best match)</option>
                </select>
                <p style={helpStyle}>{HELP.clips}</p>
              </div>

              {e.clips_source !== "none" && (
                <div>
                  <label style={labelStyle}>How many scenes are clips: {e.clips_ratio}%</label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={e.clips_ratio}
                    onChange={(ev) => set("clips_ratio", Number(ev.target.value))}
                    style={{ width: "100%" }}
                  />
                  <p style={helpStyle}>{HELP.ratio}</p>
                </div>
              )}

              <div>
                <label style={labelStyle}>Still images</label>
                <select className="input" value={e.stills_source} onChange={(ev) => set("stills_source", ev.target.value as StillsSource)}>
                  <option value="ai">AI-generated (nano-banana)</option>
                  <option value="stock">Real photos (web · best match)</option>
                </select>
                <p style={helpStyle}>{HELP.stills}</p>
              </div>
            </div>

            {/* AUDIO */}
            <div style={{ display: "grid", gap: 12, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <h3 style={{ fontWeight: 700, fontSize: 13, letterSpacing: "0.02em", color: "var(--fg-muted)", textTransform: "uppercase", margin: 0 }}>
                Audio
              </h3>
              <div>
                <label style={labelStyle}>Voiceover</label>
                <select className="input" value={e.voiceover ? "1" : "0"} onChange={(ev) => set("voiceover", ev.target.value === "1")}>
                  <option value="1">On — AI narration</option>
                  <option value="0">Off — no narration</option>
                </select>
                <p style={helpStyle}>{HELP.voiceover}</p>
              </div>
              <div>
                <label style={labelStyle}>
                  Voice{" "}
                  {!e.voiceover && (
                    <span style={{ color: "var(--fg-faint)", fontWeight: 400 }}>(applies when voiceover is on)</span>
                  )}
                </label>
                <input
                  className="input"
                  value={e.voice_id}
                  placeholder="Leave empty = default voice from Settings"
                  onChange={(ev) => set("voice_id", ev.target.value)}
                />
                <p style={helpStyle}>{HELP.voice}</p>
              </div>
            </div>

            {/* Advanced settings — collapsed by default so the editor stays simple */}
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowAdvanced((s) => !s)}
                style={{ fontSize: 13 }}
              >
                {showAdvanced
                  ? "▾ Hide advanced settings"
                  : "▸ Show more settings — real subjects, clip audio, stat card, prompts"}
              </button>
            </div>

            {showAdvanced && (
              <>
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
                  <label style={labelStyle}>Real photos of real subjects (Wikipedia)</label>
                  <select className="input" value={e.real_subjects ? "1" : "0"} onChange={(ev) => set("real_subjects", ev.target.value === "1")}>
                    <option value="1">On</option>
                    <option value="0">Off</option>
                  </select>
                  <p style={helpStyle}>{HELP.real}</p>
                </div>

                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
                  <label style={labelStyle}>Keep AI clip sounds</label>
                  <select className="input" value={e.keep_clip_audio ? "1" : "0"} onChange={(ev) => set("keep_clip_audio", ev.target.value === "1")}>
                    <option value="0">Off</option>
                    <option value="1">On</option>
                  </select>
                  <p style={helpStyle}>{HELP.keepClipAudio}</p>
                </div>

            {/* OVERLAY */}
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <label style={labelStyle}>Battle stat card</label>
              <select className="input" value={e.battle_card ? "1" : "0"} onChange={(ev) => set("battle_card", ev.target.value === "1")}>
                <option value="0">Off</option>
                <option value="1">On — intro VS stat card</option>
              </select>
              <p style={helpStyle}>{HELP.battle}</p>
            </div>

            {/* THUMBNAILS */}
            <div style={{ display: "grid", gap: 12, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <div>
                <label style={labelStyle}>Auto thumbnail</label>
                <select className="input" value={e.thumbnail ? "1" : "0"} onChange={(ev) => set("thumbnail", ev.target.value === "1")}>
                  <option value="0">Off</option>
                  <option value="1">On — generate thumbnail options</option>
                </select>
                <p style={helpStyle}>{HELP.thumbnail}</p>
              </div>
              {e.thumbnail && (
                <div>
                  <label style={labelStyle}>Thumbnail master prompt</label>
                  <p style={helpStyle}>{HELP.thumbnailPrompt}</p>
                  <textarea
                    className="textarea"
                    rows={5}
                    style={{ marginTop: 6 }}
                    value={e.thumbnail_prompt}
                    onChange={(ev) => set("thumbnail_prompt", ev.target.value)}
                    placeholder="e.g. Bold close-up of the main subject, dramatic rim light, dark vignette, empty space on the left for a title, hyper-real, high contrast"
                  />
                </div>
              )}
            </div>

            {/* PROMPTS */}
            <div style={{ display: "grid", gap: 12, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <h3 style={{ fontWeight: 700, fontSize: 13, letterSpacing: "0.02em", color: "var(--fg-muted)", textTransform: "uppercase", margin: 0 }}>
                Prompts — you write these
              </h3>
              <div>
                <label style={labelStyle}>Scene Split prompt</label>
                <p style={helpStyle}>{HELP.sceneSplit}</p>
                <textarea className="textarea" rows={10} style={{ marginTop: 6 }} value={e.scene_split} onChange={(ev) => set("scene_split", ev.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Image Style prompt</label>
                <p style={helpStyle}>The look applied to every AI image (e.g. “cinematic, film-grain, moody light”).</p>
                <textarea className="textarea" rows={4} style={{ marginTop: 6 }} value={e.image_prompt} onChange={(ev) => set("image_prompt", ev.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Animation Motion prompt</label>
                <p style={helpStyle}>How the AI (Veo) clips move — subtle parallax vs dramatic motion.</p>
                <textarea className="textarea" rows={3} style={{ marginTop: 6 }} value={e.animation_motion} onChange={(ev) => set("animation_motion", ev.target.value)} />
              </div>
            </div>
              </>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={save}>
                {saved ? "Saved ✓" : "Save channel"}
              </button>
              <button className="btn-danger" onClick={remove}>
                {e.id ? "Delete" : "Cancel"}
              </button>
            </div>
          </div>
        ) : (
          <div className="card" style={{ flex: 1, minWidth: 380, color: "var(--fg-muted)" }}>
            Select a channel on the left, or create a new one.
          </div>
        )}
      </div>
    </div>
  );
}

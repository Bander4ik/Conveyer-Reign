"use client";
import { useEffect, useState } from "react";

interface Channel {
  id: string;
  name: string;
  scene_split: string;
  image_prompt: string;
  animation_motion: string;
  battle_card: boolean;
}

const BATTLE_HELP =
  "Adds an intro “VS” stat card (e.g. weight / bite force / speed) at the start of the video. " +
  "Works with any content — turn it on for matchup videos.";

const SCENE_SPLIT_HELP =
  "How the LLM slices your script into scenes. This prompt also decides EACH scene's visual per scene — " +
  "so one video can freely mix AI footage, real photos, and real people. Add a \"visual_type\" of " +
  "\"generated\" (AI), \"real_image\" (a real photo via \"real_image_query\"), or \"person_overlay\" " +
  "(a real person via \"wikipedia_lookup\" + \"person_name\"). No visual_type = generated.";

function blank(defaults: Pick<Channel, "scene_split" | "image_prompt" | "animation_motion">): Channel {
  return {
    id: "",
    name: "",
    battle_card: false,
    scene_split: defaults.scene_split,
    image_prompt: defaults.image_prompt,
    animation_motion: defaults.animation_motion,
  };
}

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [defaults, setDefaults] = useState({ scene_split: "", image_prompt: "", animation_motion: "" });
  const [editing, setEditing] = useState<Channel | null>(null);
  const [saved, setSaved] = useState(false);

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

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>Channels</h1>
      <p style={{ color: "var(--fg-muted)", marginBottom: 16, lineHeight: 1.6 }}>
        Save a separate setup per channel so different content never gets mixed up. Pick a channel on
        the <strong>New run</strong> page and the run uses its prompts. A new channel starts from your
        global <a href="/prompts">Prompts</a> defaults. The look of each scene (AI vs real photo) is
        decided per scene by the Scene Split prompt — so one video can mix freely.
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
              const active = editing?.id === c.id && !!c.id;
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
                  {c.battle_card && <span className="badge badge-accent">stat card</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Editor */}
        {editing ? (
          <div className="card" style={{ flex: 1, minWidth: 360, display: "grid", gap: 14 }}>
            <div>
              <label className="label">Channel name</label>
              <input
                className="input"
                value={editing.name}
                placeholder="e.g. Science, Animal Battles"
                onChange={(e) => set("name", e.target.value)}
              />
            </div>

            <div>
              <label className="label">Battle stat card</label>
              <select
                className="input"
                value={editing.battle_card ? "1" : "0"}
                onChange={(e) => set("battle_card", e.target.value === "1")}
              >
                <option value="0">Off</option>
                <option value="1">On — intro VS stat card</option>
              </select>
              <p style={{ color: "var(--fg-faint)", fontSize: 12.5, marginTop: 6, lineHeight: 1.5 }}>
                {BATTLE_HELP}
              </p>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "grid", gap: 12 }}>
              <div>
                <label className="label">Scene Split prompt</label>
                <p style={{ color: "var(--fg-faint)", fontSize: 12, margin: "0 0 6px", lineHeight: 1.5 }}>
                  {SCENE_SPLIT_HELP}
                </p>
                <textarea
                  className="textarea"
                  rows={12}
                  value={editing.scene_split}
                  onChange={(e) => set("scene_split", e.target.value)}
                />
              </div>
              <div>
                <label className="label">Image Style prompt</label>
                <p style={{ color: "var(--fg-faint)", fontSize: 12, margin: "0 0 6px" }}>
                  The look applied to every AI image (e.g. “cinematic, film-grain, moody light”).
                </p>
                <textarea
                  className="textarea"
                  rows={4}
                  value={editing.image_prompt}
                  onChange={(e) => set("image_prompt", e.target.value)}
                />
              </div>
              <div>
                <label className="label">Animation Motion prompt</label>
                <p style={{ color: "var(--fg-faint)", fontSize: 12, margin: "0 0 6px" }}>
                  How the Veo clips move (subtle parallax vs dramatic motion).
                </p>
                <textarea
                  className="textarea"
                  rows={3}
                  value={editing.animation_motion}
                  onChange={(e) => set("animation_motion", e.target.value)}
                />
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={save}>
                {saved ? "Saved ✓" : "Save channel"}
              </button>
              <button className="btn-danger" onClick={remove}>
                {editing.id ? "Delete" : "Cancel"}
              </button>
            </div>
          </div>
        ) : (
          <div className="card" style={{ flex: 1, minWidth: 360, color: "var(--fg-muted)" }}>
            Select a channel on the left, or create a new one.
          </div>
        )}
      </div>
    </div>
  );
}

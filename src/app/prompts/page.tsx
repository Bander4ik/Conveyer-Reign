"use client";
import { useEffect, useState } from "react";

const META: { name: string; label: string; help: string; rows: number }[] = [
  {
    name: "scene_split",
    label: "Scene Split — system prompt for Gemini",
    help:
      "This prompt instructs the LLM how to slice your script into individual scenes. The model must " +
      "return a JSON array. Each scene has `text` (verbatim slice of the script), `visual_prompt` " +
      "(English description of the shot for the image generator), and `duration_hint_sec`. " +
      "Modify this to change the visual style direction or to adjust how aggressively the script is split.",
    rows: 18,
  },
  {
    name: "image_prompt",
    label: "Image Style — suffix appended to every image prompt",
    help:
      "Pure style instructions (no subject matter) appended to every scene's visual_prompt before being " +
      "sent to the image model. Defines the look-and-feel of the entire channel — e.g. \"documentary " +
      "photography, photoreal, no people\" vs \"painterly artwork, dreamy lighting\". The actual subject of " +
      "each shot comes from Gemini's per-scene visual_prompt.",
    rows: 5,
  },
  {
    name: "animation_motion",
    label: "Animation Motion — motion style for img2vid (Veo)",
    help:
      "Appended to every scene's visual_prompt when img2vid is enabled. Tells the video model what kind " +
      "of motion you want — subtle parallax for living-photo feel, vs aggressive movement for dramatic " +
      "B-roll. Doesn't affect static (Ken-Burns) clips.",
    rows: 4,
  },
];

export default function PromptsPage() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  async function load() {
    const r = await fetch("/api/prompts");
    setValues(await r.json());
  }
  useEffect(() => { load(); }, []);

  async function save() {
    await fetch("/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>Prompts</h1>
      <p style={{ color: "#8a8aa0", marginBottom: 16, lineHeight: 1.6 }}>
        These are the system prompts that drive how the LLM splits scripts and what visual style the
        image/video generators produce. Changes take effect on the next run — no restart needed.
      </p>
      <div style={{ marginBottom: 12 }}>
        <button className="btn" onClick={save}>{saved ? "Saved ✓" : "Save all prompts"}</button>
      </div>
      {META.map((m) => (
        <div key={m.name} className="card" style={{ marginBottom: 14 }}>
          <h3 style={{ fontWeight: 700, marginBottom: 4 }}>{m.label}</h3>
          <p style={{ color: "#9090a8", fontSize: 13, marginBottom: 10, lineHeight: 1.5 }}>{m.help}</p>
          <textarea
            className="textarea"
            rows={m.rows}
            value={values[m.name] ?? ""}
            onChange={(e) => setValues({ ...values, [m.name]: e.target.value })}
          />
        </div>
      ))}
    </div>
  );
}

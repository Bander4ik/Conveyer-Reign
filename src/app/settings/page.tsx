"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { GroupCard, dropMaskedSecrets, type Group } from "./_GroupCard";

/**
 * /settings — Keys & Drive only. Everything else (storage path, scene-split
 * tuning, TTS voice settings, image / animation provider knobs, performance,
 * alternative providers) lives at /settings/advanced so this page stays
 * focused on what new users actually need to fill in.
 *
 * Sections shown here:
 *   1. Required API Keys (GOOGLE_API_KEY, LABS69_API_KEY)
 *   2. Google Drive Sync — connection status, OAuth flow, credential inputs,
 *      first-time setup guide for Google Cloud Console.
 *
 * The two pages share the /api/settings GET/POST endpoint. Only fields the
 * page renders are sent on save, so there's no double-save race between the
 * two screens.
 */

const MAIN_GROUPS: Group[] = [
  {
    title: "Required API Keys",
    subtitle: "The bare minimum needed to run the pipeline. Without these two keys, nothing works.",
    required: true,
    fields: [
      {
        key: "GOOGLE_API_KEY",
        desc: "Powers scene splitting — Gemini reads your script and breaks it into individual scenes with visual prompts. The same Google account can be used for the Google Drive sync below.",
        examples: "Get it free at https://aistudio.google.com/app/apikey (Create API key)",
        required: true,
      },
      {
        key: "LABS69_API_KEY",
        desc: "All-in-one key for voice, images, and video animation through 69labs.vip. Replaces three separate provider subscriptions.\n\nPRO TIP: You can paste multiple keys from different 69labs accounts (one per line, or comma-separated). Each account adds another 7 parallel image jobs + 5 parallel video jobs to the pool. With 3 keys, generation is roughly 3× faster.",
        examples: "Single key: vk_abc... · Multiple keys: paste each on its own line. Each starts with vk_",
        required: true,
        multiline: true,
      },
    ],
  },
];

interface GdriveStatus {
  connected: boolean;
  email?: string;
  error?: string;
  errorKind?: "api_not_enabled" | "auth_invalid" | "network" | "other";
  enableUrl?: string;
  syncEnabled: boolean;
  credentialsConfigured: boolean;
}

export default function SettingsPage() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [gdrive, setGdrive] = useState<GdriveStatus | null>(null);

  async function load(reveal = false) {
    const [settingsR, gdriveR] = await Promise.all([
      fetch(`/api/settings${reveal ? "?reveal=1" : ""}`).then((r) => r.json()),
      fetch("/api/gdrive/status").then((r) => r.json()).catch(() => null),
    ]);
    setValues(settingsR);
    setGdrive(gdriveR);
    setRevealing(reveal);
  }

  useEffect(() => { load(false); }, []);

  // Show a one-shot banner after the OAuth callback redirects us back here
  // with ?gdrive=connected or ?gdrive=error&reason=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gd = params.get("gdrive");
    if (!gd) return;
    if (gd === "connected") {
      alert("Google Drive connected ✓");
    } else if (gd === "error") {
      alert(`Google Drive connect failed: ${params.get("reason") || "unknown"}`);
    }
    // Strip the query param so the alert doesn't repeat on reload
    window.history.replaceState({}, "", "/settings");
  }, []);

  async function save() {
    const cleaned = dropMaskedSecrets(values);
    const r = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cleaned),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({} as { error?: string }));
      alert(`Save failed: ${j.error || r.statusText}`);
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    load(revealing);
  }

  async function disconnectGdrive() {
    if (!confirm("Disconnect Google Drive? You'll need to re-authorize to upload again.")) return;
    await fetch("/api/gdrive/disconnect", { method: "POST" });
    load(revealing);
  }

  function connectGdrive() {
    if (!gdrive?.credentialsConfigured) {
      alert("Fill GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET, then click 'Save all changes' before connecting.");
      return;
    }
    window.location.href = "/api/gdrive/oauth/start";
  }

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>Keys &amp; Settings</h1>
      <p style={{ color: "#8a8aa0", marginBottom: 16, lineHeight: 1.6 }}>
        Required API keys + Google Drive sync. Everything else lives at{" "}
        <Link href="/settings/advanced" style={{ color: "#7c5cff" }}>Advanced settings →</Link>
      </p>

      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 16,
          position: "sticky",
          top: 0,
          background: "var(--bg)",
          padding: "8px 0",
          zIndex: 10,
        }}
      >
        <button className="btn-secondary" onClick={() => load(!revealing)}>
          {revealing ? "Hide secret values" : "Reveal secret values (to edit)"}
        </button>
        <button className="btn" onClick={save}>{saved ? "Saved ✓" : "Save all changes"}</button>
      </div>

      {/* ─── Required API Keys group ───────────────────────────────────── */}
      {MAIN_GROUPS.map((g) => (
        <GroupCard key={g.title} group={g} values={values} setValues={setValues} />
      ))}

      {/* ─── Google Drive Sync ─────────────────────────────────────────── */}
      <div
        className="card"
        style={{ marginBottom: 14, borderColor: "#3a5a8a", borderWidth: 2 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <h3 style={{ fontWeight: 700, fontSize: 16 }}>Google Drive Sync</h3>
          <span
            style={{
              background: "#1d2a3a",
              color: "#7cb8ff",
              padding: "2px 8px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.5,
            }}
          >
            OPTIONAL
          </span>
        </div>
        <p style={{ color: "#8a8aa0", fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
          Auto-upload finished runs to your Google Drive. Final videos go to one folder, raw scene clips
          (without voiceover) plus a description blob go to another — so AI can later find relevant clips
          from past runs to reuse in new ones.
        </p>

        {/* Status banner */}
        {gdrive && (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 6,
              marginBottom: 14,
              background: gdrive.connected
                ? "#1a2a1a"
                : gdrive.error
                  ? "#2a1a1a"
                  : "#1a1a28",
              border: `1px solid ${
                gdrive.connected ? "#3a5a3a" : gdrive.error ? "#5a3a3a" : "#2a2a3a"
              }`,
            }}
          >
            {gdrive.connected ? (
              <span style={{ color: "#6dd66d", fontWeight: 600, fontSize: 13 }}>
                ✓ Connected as{" "}
                <span style={{ color: "#e8e8f0" }}>{gdrive.email || "(unknown email)"}</span>
              </span>
            ) : gdrive.error ? (
              <div>
                {gdrive.errorKind === "api_not_enabled" ? (
                  <>
                    <div style={{ color: "#ff6d6d", fontWeight: 600, fontSize: 13 }}>
                      ❌ Google Drive API is not enabled in your Google Cloud project
                    </div>
                    <div style={{ color: "#cfcfdf", fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>
                      Open the link below, click the blue <strong>Enable</strong> button, wait ~1 min, then refresh this page:
                    </div>
                    {gdrive.enableUrl && (
                      <a
                        href={gdrive.enableUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: "#7c5cff",
                          fontSize: 12,
                          marginTop: 6,
                          display: "inline-block",
                          wordBreak: "break-all",
                        }}
                      >
                        {gdrive.enableUrl}
                      </a>
                    )}
                  </>
                ) : gdrive.errorKind === "auth_invalid" ? (
                  <div style={{ color: "#ff6d6d", fontWeight: 600, fontSize: 13 }}>
                    ❌ Token expired or revoked — click <strong>Reconnect</strong>
                  </div>
                ) : gdrive.errorKind === "network" ? (
                  <div style={{ color: "#ffce4d", fontWeight: 600, fontSize: 13 }}>
                    ⚠ Network error reaching Google — check your connection and refresh
                  </div>
                ) : (
                  <div style={{ color: "#ff6d6d", fontWeight: 600, fontSize: 13 }}>
                    ❌ Drive connection issue — see details below
                  </div>
                )}
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: "pointer", color: "#9090a8", fontSize: 11 }}>
                    Raw error
                  </summary>
                  <div
                    style={{
                      color: "#9090a8",
                      fontSize: 11,
                      marginTop: 4,
                      fontFamily: "ui-monospace, monospace",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {gdrive.error}
                  </div>
                </details>
              </div>
            ) : gdrive.credentialsConfigured ? (
              <span style={{ color: "#ffce4d", fontWeight: 600, fontSize: 13 }}>
                ⚠ Not connected — click <strong>Connect Google Drive</strong> below
              </span>
            ) : (
              <span style={{ color: "#9090a8", fontWeight: 600, fontSize: 13 }}>
                ℹ Fill <code>GDRIVE_CLIENT_ID</code> + <code>GDRIVE_CLIENT_SECRET</code> below, click{" "}
                <strong>Save all changes</strong>, then come back to connect.
              </span>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {gdrive?.connected ? (
            <>
              <button className="btn-secondary" onClick={connectGdrive}>
                Reconnect (switch account)
              </button>
              <button
                className="btn-secondary"
                onClick={disconnectGdrive}
                style={{ color: "#ff8888" }}
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              className="btn"
              onClick={connectGdrive}
              disabled={!gdrive?.credentialsConfigured}
              style={{ opacity: gdrive?.credentialsConfigured ? 1 : 0.5 }}
            >
              Connect Google Drive
            </button>
          )}
        </div>

        {/* Auto-sync toggle */}
        <div
          style={{
            marginBottom: 14,
            padding: "10px 12px",
            background: "#0e0e16",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            <input
              type="checkbox"
              checked={values.GDRIVE_SYNC_ENABLED === "1"}
              onChange={(e) =>
                setValues({ ...values, GDRIVE_SYNC_ENABLED: e.target.checked ? "1" : "" })
              }
              style={{ width: 16, height: 16 }}
            />
            <span>Auto-upload finished runs to Drive</span>
          </label>
          <span style={{ color: "#5a5a70", fontSize: 11 }}>
            Uploads final video + raw clips + metadata after each successful run. Toggle saves with{" "}
            <strong>Save all changes</strong>.
          </span>
        </div>

        {/* Credentials + folder inputs */}
        <div style={{ display: "grid", gap: 14 }}>
          {[
            {
              key: "GDRIVE_CLIENT_ID",
              desc: "OAuth Client ID from Google Cloud Console (Web Application type). Treated as secret — masked after save.",
              examples: "Format: 123456789-abc.apps.googleusercontent.com",
            },
            {
              key: "GDRIVE_CLIENT_SECRET",
              desc: "OAuth Client Secret from the same credential. Treated as a secret — masked after save.",
              examples: "Format: GOCSPX-xxxxxxxxxxxxxxxx",
            },
            {
              key: "GDRIVE_FINAL_VIDEOS_FOLDER_ID",
              desc: "Drive folder ID for finished videos. Leave empty to auto-create `Conveyer/Final Videos/` in your Drive root on first sync.",
              examples: "From folder URL: drive.google.com/drive/folders/<THIS_PART>",
            },
            {
              key: "GDRIVE_CLIPS_LIBRARY_FOLDER_ID",
              desc: "Drive folder ID for per-run sub-folders with raw clips + clips.json + description.md. Leave empty to auto-create `Conveyer/Clips Library/`.",
              examples: "Same format as above",
            },
          ].map((f) => (
            <div key={f.key}>
              <div style={{ marginBottom: 4 }}>
                <label
                  className="label"
                  style={{
                    margin: 0,
                    color: "#b8b8c8",
                    fontWeight: 600,
                    fontSize: 12,
                    letterSpacing: 0.3,
                  }}
                >
                  {f.key}
                </label>
              </div>
              <input
                className="input"
                value={values[f.key] ?? ""}
                placeholder={`e.g. ${f.examples}`}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
              <div style={{ color: "#9090a8", fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                {f.desc}
              </div>
              <div
                style={{
                  color: "#5a5a70",
                  fontSize: 11,
                  marginTop: 4,
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {f.examples}
              </div>
            </div>
          ))}
        </div>

        {/* Collapsible setup guide */}
        <details
          style={{
            marginTop: 14,
            padding: 12,
            background: "#0e0e16",
            borderRadius: 6,
            border: "1px solid #2a2a3a",
          }}
        >
          <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13, color: "#b8b8c8" }}>
            First-time setup — how to get Client ID / Secret (click to expand)
          </summary>
          <ol
            style={{
              marginTop: 10,
              paddingLeft: 20,
              color: "#9090a8",
              fontSize: 12,
              lineHeight: 1.7,
            }}
          >
            <li>
              Open{" "}
              <a
                href="https://console.cloud.google.com/"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#7c5cff" }}
              >
                Google Cloud Console
              </a>{" "}
              using the SAME Google account that owns the Drive you want clips saved to
            </li>
            <li>Create a new project (or reuse an existing one) — name it anything like &ldquo;Conveyer&rdquo;</li>
            <li>
              APIs &amp; Services → Library → search <strong>Google Drive API</strong> → click{" "}
              <strong>Enable</strong> (this is what makes the API call work later)
            </li>
            <li>
              APIs &amp; Services → <strong>OAuth consent screen</strong> → choose{" "}
              <strong>External</strong> → fill the required fields (app name, support email,
              developer email) and save
            </li>
            <li style={{ color: "#ffce4d" }}>
              <strong>⚠ DO NOT SKIP — add yourself as a Test user.</strong> In the OAuth consent
              screen, open the <strong>Audience</strong> (or <strong>Test users</strong>) section →
              click <strong>Add users</strong> → type the EXACT Gmail address you will log in with
              when connecting → Save. If you skip this, connecting fails with{" "}
              <em>&ldquo;Access blocked: Conveyer has not completed the Google verification
              process&rdquo; (Error 403: access_denied)</em>.
            </li>
            <li>
              APIs &amp; Services → Credentials → <strong>Create Credentials</strong> → OAuth client
              ID → <strong>Web Application</strong>
            </li>
            <li>
              In Authorized redirect URIs add this exact line:{" "}
              <code style={{ background: "#000", padding: "2px 6px", borderRadius: 4 }}>
                http://localhost:3000/api/gdrive/oauth/callback
              </code>
            </li>
            <li>
              After clicking Create, Google shows you the{" "}
              <strong>Client ID</strong> and <strong>Client Secret</strong>. Copy both into the
              fields above.
            </li>
            <li>
              Click <strong>Save all changes</strong> at the top of this page
            </li>
            <li>
              Click <strong>Connect Google Drive</strong> — a browser tab will open, log in with the
              same Gmail account you added to &ldquo;Test users&rdquo; in step 5, click{" "}
              <strong>Continue</strong> past the &ldquo;app not verified&rdquo; warning (it's normal
              for personal apps), grant access, and you'll be redirected back here with a green ✓
            </li>
            <li>
              Toggle <strong>Auto-upload finished runs to Drive</strong> above, save once more, and
              every future pipeline run will end with its clips uploaded to{" "}
              <code>Conveyer/Clips Library/</code> and the final video in{" "}
              <code>Conveyer/Final Videos/</code> in your Drive root.
            </li>
          </ol>

          {/* Dedicated callout for the most common setup failure */}
          <div
            style={{
              marginTop: 12,
              padding: "10px 12px",
              background: "#2a1a1a",
              border: "1px solid #5a3a3a",
              borderRadius: 6,
            }}
          >
            <div style={{ color: "#ff8888", fontWeight: 700, fontSize: 12, marginBottom: 4 }}>
              ❌ Stuck on &ldquo;Access blocked: ... has not completed the Google verification process&rdquo;?
            </div>
            <div style={{ color: "#cfcfdf", fontSize: 11.5, lineHeight: 1.6 }}>
              That &ldquo;Error 403: access_denied&rdquo; means the Gmail you're logging in with is
              NOT in the project's <strong>Test users</strong> list. Go back to Google Cloud Console
              → APIs &amp; Services → OAuth consent screen → Audience / Test users → <strong>Add
              users</strong> → add that exact email → Save. Then click{" "}
              <strong>Connect Google Drive</strong> again. No code changes needed — it's purely a
              Google Cloud setting.
            </div>
          </div>
          <p
            style={{
              marginTop: 12,
              color: "#5a5a70",
              fontSize: 11,
              lineHeight: 1.6,
              fontStyle: "italic",
            }}
          >
            Why two folders? Final videos are what you share. Raw clips are kept separately so the
            platform can later search them when generating a new video — if a relevant clip already
            exists for a scene, it gets reused instead of regenerated, saving credits and time.
          </p>
        </details>
      </div>
    </div>
  );
}

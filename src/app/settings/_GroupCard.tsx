"use client";

// Shared field/group renderer used by both /settings (Keys & Drive) and
// /settings/advanced. Extracted so the two pages stay visually identical
// without copy-pasting ~80 lines of inputs + tooltips + masking-aware
// secret hint rendering.

export interface Field {
  key: string;
  label?: string;
  desc: string;
  examples?: string;
  required?: boolean;
  multiline?: boolean;
}

export interface Group {
  title: string;
  subtitle?: string;
  required?: boolean;
  fields: Field[];
}

export function GroupCard(props: {
  group: Group;
  values: Record<string, string>;
  setValues: (v: Record<string, string>) => void;
}) {
  const { group: g, values, setValues } = props;
  return (
    <div
      className="card"
      style={{
        marginBottom: 14,
        borderColor: g.required ? "#ff6d6d" : undefined,
        borderWidth: g.required ? 2 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <h3 style={{ fontWeight: 700, fontSize: 16 }}>{g.title}</h3>
        {g.required && (
          <span
            style={{
              background: "#3a1d1d",
              color: "#ff6d6d",
              padding: "2px 8px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.5,
            }}
          >
            REQUIRED
          </span>
        )}
      </div>
      {g.subtitle && (
        <p style={{ color: "#8a8aa0", fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
          {g.subtitle}
        </p>
      )}
      <div style={{ display: "grid", gap: 14 }}>
        {g.fields.map((f) => (
          <div key={f.key}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
              <label
                className="label"
                style={{
                  margin: 0,
                  color: f.required ? "#ff8888" : "#b8b8c8",
                  fontWeight: 600,
                  fontSize: 12,
                  letterSpacing: 0.3,
                }}
              >
                {f.key}
              </label>
              {f.required && (
                <span style={{ color: "#ff6d6d", fontSize: 10, fontWeight: 700 }}>required</span>
              )}
            </div>
            {f.multiline ? (
              <textarea
                className="textarea"
                value={values[f.key] ?? ""}
                placeholder={f.examples ? `e.g. ${f.examples}` : ""}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                rows={Math.max(2, Math.min(6, (values[f.key] ?? "").split(/\n/).length + 1))}
                style={{
                  borderColor: f.required && !values[f.key] ? "#ff6d6d" : undefined,
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 13,
                }}
              />
            ) : (
              <input
                className="input"
                value={values[f.key] ?? ""}
                placeholder={f.examples ? `e.g. ${f.examples}` : ""}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                style={{
                  borderColor: f.required && !values[f.key] ? "#ff6d6d" : undefined,
                }}
              />
            )}
            {f.key === "LABS69_API_KEY" && values[f.key] && (
              <div style={{ color: "#7c5cff", fontSize: 12, marginTop: 6 }}>
                🔑 Detected{" "}
                <strong>
                  {values[f.key].split(/[\n,;]+/).map((k) => k.trim()).filter(Boolean).length}
                </strong>
                {" "}key
                {values[f.key].split(/[\n,;]+/).map((k) => k.trim()).filter(Boolean).length === 1 ? "" : "s"}
              </div>
            )}
            <div
              style={{
                color: "#9090a8",
                fontSize: 12,
                marginTop: 6,
                lineHeight: 1.5,
                whiteSpace: "pre-line",
              }}
            >
              {f.desc}
            </div>
            {f.examples && (
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
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Strips fields whose value is still a masked placeholder ("AIza…XXXX").
 *  Sending those back would overwrite the real key in the DB with garbage
 *  containing U+2026 — breaking every later API call.
 *  Same defense lives in /api/settings POST; both layers are intentional.
 */
export function dropMaskedSecrets(values: Record<string, string>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    const isSecret = k.includes("KEY") || k.includes("TOKEN") || k.includes("SECRET");
    if (isSecret && typeof v === "string" && v.includes("…")) continue;
    cleaned[k] = v;
  }
  return cleaned;
}

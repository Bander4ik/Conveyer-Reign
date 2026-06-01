"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

interface RunRow {
  id: string;
  title: string | null;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  created_at: string;
  updated_at: string;
  output_path: string | null;
}

export default function RunsListPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);

  useEffect(() => {
    let alive = true;
    async function tick() {
      const r = await fetch("/api/runs");
      if (!alive) return;
      setRuns(await r.json());
    }
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 16 }}>Run history</h1>
      {runs.length === 0 && <p style={{ color: "#8a8aa0" }}>No runs yet.</p>}
      <div style={{ display: "grid", gap: 8 }}>
        {runs.map((r) => (
          <Link key={r.id} href={`/runs/${r.id}`} className="card" style={{ textDecoration: "none" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 700 }}>{r.title || r.id.slice(0, 8)}</div>
                <div style={{ color: "#8a8aa0", fontSize: 12 }}>{r.created_at}</div>
              </div>
              <span className={`tag tag-${r.status}`}>{r.status}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

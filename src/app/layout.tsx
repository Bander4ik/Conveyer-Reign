import "./globals.css";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata = {
  title: "Conveyer Reign",
  description: "Local pipeline platform for faceless AI YouTube videos.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div style={{ minHeight: "100vh", display: "flex" }}>
          <nav className="card" style={{ width: 220, margin: 16, padding: 20, height: "fit-content" }}>
            <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 16 }}>
              Conveyer&nbsp;Reign
            </div>
            <Link href="/" style={navLink}>New run</Link>
            <Link href="/runs" style={navLink}>Run history</Link>
            <Link href="/library" style={navLink}>Drive library</Link>
            <Link href="/prompts" style={navLink}>Prompts</Link>
            <Link href="/settings" style={navLink}>Keys &amp; Settings</Link>
            <Link href="/settings/advanced" style={navLink}>Advanced settings</Link>
            <div style={{ marginTop: 24, fontSize: 12, color: "#8a8aa0" }}>
              v0.1 · local
            </div>
          </nav>
          <main style={{ flex: 1, padding: "16px 24px 64px 8px", maxWidth: 1100 }}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

const navLink: React.CSSProperties = {
  display: "block",
  padding: "8px 10px",
  borderRadius: 8,
  marginBottom: 4,
  color: "#e8e8f0",
  textDecoration: "none",
};

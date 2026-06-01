import "./globals.css";
import type { ReactNode } from "react";
import { Sidebar } from "./_sidebar";

export const metadata = {
  title: "Conveyer Reign",
  description: "Local pipeline for faceless AI YouTube videos.",
};

// Applied before first paint so the chosen theme doesn't flash (anti-FOUC).
// Lives as the first node inside <body> — a manual <head> in an App Router
// layout breaks hydration, so it must NOT go there.
const themeScript = `try{if(localStorage.getItem('theme')==='light'){document.documentElement.setAttribute('data-theme','light');}}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <div style={{ display: "flex", minHeight: "100vh" }}>
          <Sidebar />
          <main style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "center" }}>
            <div style={{ width: "100%", maxWidth: 1080, padding: "32px 36px 80px" }}>
              {children}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}

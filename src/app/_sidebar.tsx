"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ThemeToggle } from "./_theme-toggle";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  exact?: boolean;
}

const iconProps = {
  width: 17,
  height: 17,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const NAV: NavItem[] = [
  {
    href: "/",
    label: "New run",
    exact: true,
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M12 8v8M8 12h8" />
      </svg>
    ),
  },
  {
    href: "/runs",
    label: "Run history",
    icon: (
      <svg {...iconProps}>
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5M12 7v5l4 2" />
      </svg>
    ),
  },
  {
    href: "/library",
    label: "Drive library",
    icon: (
      <svg {...iconProps}>
        <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
      </svg>
    ),
  },
  {
    href: "/prompts",
    label: "Prompts",
    icon: (
      <svg {...iconProps}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
      </svg>
    ),
  },
  {
    href: "/channels",
    label: "Channels",
    icon: (
      <svg {...iconProps}>
        <path d="M12 2 2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    ),
  },
  {
    href: "/settings",
    label: "Keys & Settings",
    exact: true,
    icon: (
      <svg {...iconProps}>
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3" />
      </svg>
    ),
  },
  {
    href: "/settings/advanced",
    label: "Advanced settings",
    exact: true,
    icon: (
      <svg {...iconProps}>
        <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
      </svg>
    ),
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      style={{
        width: 244,
        flexShrink: 0,
        height: "100vh",
        position: "sticky",
        top: 0,
        background: "var(--bg-deep)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        padding: "20px 14px",
      }}
    >
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px 22px" }}>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: "linear-gradient(135deg, var(--accent), #ff8a72)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 800,
            fontSize: 15,
            color: "#fff",
            boxShadow: "var(--shadow-sm)",
            flexShrink: 0,
          }}
        >
          C
        </div>
        <div style={{ lineHeight: 1.15 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, letterSpacing: "-0.02em" }}>
            Conveyer&nbsp;Reign
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>AI video pipeline</div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {NAV.map((item) => {
          const active = item.exact
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                fontSize: 13.5,
                fontWeight: active ? 600 : 500,
                color: active ? "var(--fg)" : "var(--fg-muted)",
                background: active ? "var(--surface-2)" : "transparent",
                border: `1px solid ${active ? "var(--border-strong)" : "transparent"}`,
                textDecoration: "none",
                transition: "background 0.13s, color 0.13s, border-color 0.13s",
              }}
            >
              <span
                style={{
                  color: active ? "var(--accent)" : "var(--fg-faint)",
                  display: "flex",
                }}
              >
                {item.icon}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div style={{ marginTop: "auto", paddingTop: 14 }}>
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <ThemeToggle />
          <div style={{ fontSize: 11, color: "var(--fg-faint)", padding: "10px 10px 2px" }}>
            v0.1 · runs locally
          </div>
        </div>
      </div>
    </aside>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: Array<{ href: string; label: string; match: (p: string) => boolean }> = [
  { href: "/congress",              label: "Weekly",       match: (p) => p === "/congress" },
  { href: "/congress/timeline",     label: "Timeline",     match: (p) => p.startsWith("/congress/timeline") },
  { href: "/congress/discuss",      label: "Discuss",      match: (p) => p.startsWith("/congress/discuss") || /^\/congress\/[^/]+\/live/.test(p) },
  { href: "/congress/editor",       label: "Editor",       match: (p) => p.startsWith("/congress/editor") },
  { href: "/congress/architecture", label: "Architecture", match: (p) => p.startsWith("/congress/architecture") },
  { href: "/congress/about",        label: "About",        match: (p) => p.startsWith("/congress/about") },
];

export function CongressNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav
      style={{
        display: "flex",
        gap: 18,
        marginBottom: 24,
        paddingBottom: 14,
        borderBottom: "1px solid var(--border)",
        fontSize: 14,
        color: "var(--text-tertiary)",
      }}
    >
      {TABS.map((t) => {
        const active = t.match(pathname);
        return (
          <Link
            key={t.href}
            href={t.href}
            style={{
              textDecoration: "none",
              color: active ? "var(--text)" : "var(--text-tertiary)",
              fontWeight: active ? 600 : 400,
              borderBottom: active ? "2px solid var(--text)" : "2px solid transparent",
              paddingBottom: 6,
              marginBottom: -15,
              transition: "color 0.12s",
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

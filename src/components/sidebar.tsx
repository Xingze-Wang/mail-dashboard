"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/* ── Inline SVG icons (matching mockup-v2-light.html) ───────────────── */

const Common = {
  width: 18, height: 18, viewBox: "0 0 24 24",
  fill: "none", stroke: "currentColor",
  strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
};

const OverviewIcon = () => (
  <svg {...Common}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

const EmailsIcon = () => (
  <svg {...Common}>
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
    <polyline points="22,6 12,13 2,6" />
  </svg>
);

const InboxIcon = () => (
  <svg {...Common}>
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
    <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
  </svg>
);

const PipelineIcon = () => (
  <svg {...Common}>
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
);

const BriefIcon = () => (
  <svg {...Common}>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

const ScorerIcon = () => (
  <svg {...Common}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

const TemplatesIcon = () => (
  <svg {...Common}>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="9" y1="21" x2="9" y2="9" />
  </svg>
);

const LogsIcon = () => (
  <svg {...Common}>
    <line x1="17" y1="10" x2="3" y2="10" />
    <line x1="21" y1="6" x2="3" y2="6" />
    <line x1="21" y1="14" x2="3" y2="14" />
    <line x1="17" y1="18" x2="3" y2="18" />
  </svg>
);

const SettingsIcon = () => (
  <svg {...Common}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
  </svg>
);

const LogoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
    <polyline points="22,6 12,13 2,6" />
  </svg>
);

function initialsOf(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const mainNav = [
  { href: "/",         label: "Overview", Icon: OverviewIcon },
  { href: "/emails",   label: "Emails",   Icon: EmailsIcon, badgeKey: "ready"  as const },
  { href: "/inbox",    label: "Inbox",    Icon: InboxIcon,  badgeKey: "unread" as const },
  { href: "/pipeline", label: "Pipeline", Icon: PipelineIcon },
];

const toolsNav = [
  { href: "/brief",     label: "Brief",     Icon: BriefIcon,     adminOnly: false },
  { href: "/templates", label: "Templates", Icon: TemplatesIcon, adminOnly: false },
  { href: "/scorer",    label: "Scorer",    Icon: ScorerIcon,    adminOnly: true  },
  { href: "/logs",      label: "Logs",      Icon: LogsIcon,      adminOnly: true  },
];

interface NavItemProps {
  href: string;
  label: string;
  Icon: React.ComponentType;
  active: boolean;
  badge?: number;
}

function NavItem({ href, label, Icon, active, badge }: NavItemProps) {
  return (
    <Link href={href} className={`nav-item ${active ? "active" : ""}`}>
      <Icon />
      {label}
      {badge && badge > 0 ? <span className="badge">{badge}</span> : null}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [unread, setUnread] = useState(0);
  const [ready, setReady]   = useState(0);
  const [me, setMe] = useState<{ repId: number; repName: string; role: "admin" | "sales" } | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.authenticated) {
          setMe({ repId: d.repId, repName: d.repName, role: d.role === "admin" ? "admin" : "sales" });
        }
      })
      .catch(() => { /* not signed in */ });
  }, []);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/login");
  };

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const load = () => {
      fetch("/api/inbox/unread-count")
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setUnread(d.count ?? 0); })
        .catch(() => { /* keep last known */ });
      fetch("/api/pipeline/ready-count")
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setReady(d.count ?? 0); })
        .catch(() => { /* keep last known */ });
    };

    const start = (ms: number) => {
      if (intervalId) clearInterval(intervalId);
      intervalId = setInterval(load, ms);
    };

    load();
    start(30_000);

    // Pages can ask for tighter polling while they're mounted.
    const fastOn  = () => start(10_000);
    const fastOff = () => start(30_000);
    const onRead  = () => load();

    window.addEventListener("inbox:fast-poll-on",  fastOn);
    window.addEventListener("inbox:fast-poll-off", fastOff);
    window.addEventListener("inbox:read",          onRead);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      window.removeEventListener("inbox:fast-poll-on",  fastOn);
      window.removeEventListener("inbox:fast-poll-off", fastOff);
      window.removeEventListener("inbox:read",          onRead);
    };
  }, []);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const badgeFor = (key: "unread" | "ready" | undefined) => {
    if (key === "unread") return unread;
    if (key === "ready")  return ready;
    return undefined;
  };

  return (
    <aside className="app-sidebar">
      <div className="sidebar-logo">
        <div className="logo-icon">
          <LogoIcon />
        </div>
        <span>Miracle Mail</span>
      </div>

      <nav className="sidebar-nav">
        {mainNav.map((item) => (
          <NavItem
            key={item.href}
            href={item.href}
            label={item.label}
            Icon={item.Icon}
            active={isActive(item.href)}
            badge={badgeFor(item.badgeKey)}
          />
        ))}

        {toolsNav
          .filter((item) => !item.adminOnly || me?.role === "admin")
          .map((item) => (
            <NavItem
              key={item.href}
              href={item.href}
              label={item.label}
              Icon={item.Icon}
              active={isActive(item.href)}
            />
          ))}
      </nav>

      <div className="sidebar-footer">
        <div className="user" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {me?.role === "admin" ? (
            <Link href="/settings" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", flex: 1, minWidth: 0 }}>
              <div className="avatar">{initialsOf(me?.repName)}</div>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {me?.repName ?? "Signed out"}
                </span>
                <span style={{ fontSize: 11.5, color: "#B45309", fontWeight: 600 }}>Admin</span>
              </div>
            </Link>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
              <div className="avatar">{initialsOf(me?.repName)}</div>
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {me?.repName ?? "Signed out"}
                </span>
                <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>Sales</span>
              </div>
            </div>
          )}
          {me && (
            <button
              onClick={logout}
              title="Sign out"
              style={{ background: "transparent", border: 0, color: "var(--text-tertiary)", cursor: "pointer", padding: 4, borderRadius: 4 }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

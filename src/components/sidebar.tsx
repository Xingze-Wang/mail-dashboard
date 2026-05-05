"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, t } from "@/lib/i18n";
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

const DriftIcon = () => (
  <svg {...Common}>
    <path d="M3 12h4l3-9 4 18 3-9h4" />
  </svg>
);

// BarChart3-style icon — 3 vertical bars rising left-to-right, with an
// L-axis. Used for the Bench page to differentiate from Scorer (which
// also uses bars). Matches user's reference screenshot 2026-05-03.
const BenchIcon = () => (
  <svg {...Common}>
    <path d="M3 3v18h18" />
    <path d="M8 17V13" />
    <path d="M13 17V9" />
    <path d="M18 17V5" />
  </svg>
);

// Council/congress icon — speech-bubble cluster, signaling the
// multi-persona debate happening inside.
const CongressIcon = () => (
  <svg {...Common}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <path d="M9 9h6" />
    <path d="M9 13h4" />
  </svg>
);

// Editor icon — pen-on-page, signals "review queue / brand editor."
const EditorIcon = () => (
  <svg {...Common}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </svg>
);

// Insights icon — lightbulb, signaling "the page tells you what's
// working" rather than "raw data dump."
const InsightsIcon = () => (
  <svg {...Common}>
    <path d="M9 18h6" />
    <path d="M10 22h4" />
    <path d="M12 2a7 7 0 0 0-4 12.7c.9.7 1.4 1.4 1.5 2.3h5c.1-.9.6-1.6 1.5-2.3A7 7 0 0 0 12 2z" />
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

// Nav arrays are built inside Sidebar() so labels can be localized.

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
  const locale = useLocale();

  const mainNav = [
    { href: "/",         label: t("nav.overview", locale), Icon: OverviewIcon },
    { href: "/pipeline", label: t("nav.pipeline", locale), Icon: PipelineIcon, badgeKey: "ready"  as const },
    { href: "/emails",   label: t("nav.emails",   locale), Icon: EmailsIcon,   badgeKey: "unread" as const },
  ];

  const toolsNav = [
    { href: "/brief",     label: t("nav.brief",     locale), Icon: BriefIcon,     adminOnly: false },
    { href: "/analysis",  label: t("nav.insights",  locale), Icon: InsightsIcon,  adminOnly: false },
    { href: "/mapping",   label: "Mapping",                  Icon: TemplatesIcon, adminOnly: false },
    { href: "/templates", label: t("nav.templates", locale), Icon: TemplatesIcon, adminOnly: false },
    { href: "/congress",  label: t("nav.congress",  locale), Icon: CongressIcon,  adminOnly: true  },
    { href: "/scorer",    label: t("nav.scorer",    locale), Icon: ScorerIcon,    adminOnly: true  },
    { href: "/bench",     label: t("nav.bench",     locale), Icon: BenchIcon,     adminOnly: true  },
    { href: "/drift",     label: t("nav.drift",     locale), Icon: DriftIcon,     adminOnly: true  },
  ];
  const [unread, setUnread] = useState(0);
  const [ready, setReady]   = useState(0);
  const [me, setMe] = useState<{ repId: number; repName: string; role: "admin" | "sales" } | null>(null);
  const [accounts, setAccounts] = useState<Array<{ repId: number; repName: string; email: string; role: string; active: boolean }>>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switching, setSwitching] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadMe = () => {
      fetch("/api/auth/me", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          if (d.authenticated) {
            setMe({ repId: d.repId, repName: d.repName, role: d.role === "admin" ? "admin" : "sales" });
          } else {
            setMe(null);
          }
        })
        .catch(() => { /* keep last known */ });
      fetch("/api/auth/accounts", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setAccounts(d.accounts ?? []); })
        .catch(() => { /* keep last known */ });
    };
    loadMe();
    // Refetch on tab focus AND on a custom auth:changed event (dispatched by
    // login / logout so the sidebar updates without a full reload).
    const onFocus = () => loadMe();
    const onAuth = () => loadMe();
    window.addEventListener("focus", onFocus);
    window.addEventListener("auth:changed", onAuth);
    // Also re-check when the path changes — covers route-driven login redirects.
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("auth:changed", onAuth);
    };
  }, [pathname]);

  const logout = async () => {
    const r = await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setMe(null);
    window.dispatchEvent(new Event("auth:changed"));
    // If there was another account in the pool, the server rotated us into
    // it — just reload, stay signed in. Otherwise go to /login.
    if (d?.rotatedTo) window.location.reload();
    else window.location.assign("/login");
  };

  const switchAccount = async (repId: number) => {
    if (repId === me?.repId) { setMenuOpen(false); return; }
    setSwitching(repId);
    try {
      const r = await fetch("/api/auth/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repId }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        alert(d.error ?? "Switch failed");
        return;
      }
      // Full reload — every component holds stale user-scoped data.
      window.location.reload();
    } finally {
      setSwitching(null);
      setMenuOpen(false);
    }
  };

  const removeAccount = async (repId: number) => {
    const r = await fetch("/api/auth/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repId }),
    });
    if (!r.ok) return;
    if (repId === me?.repId) {
      // Removed self — server already rotated or cleared; reload refreshes state.
      window.location.reload();
    } else {
      setAccounts((prev) => prev.filter((a) => a.repId !== repId));
    }
  };

  // Close dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(".account-menu")) return;
      if (target?.closest?.(".user-pill")) return;
      setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

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
    // Re-pull counts when the tab regains focus or auth changes — both
    // usually mean the visible numbers are stale.
    window.addEventListener("focus",        onRead);
    window.addEventListener("auth:changed", onRead);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      window.removeEventListener("inbox:fast-poll-on",  fastOn);
      window.removeEventListener("inbox:fast-poll-off", fastOff);
      window.removeEventListener("inbox:read",          onRead);
      window.removeEventListener("focus",        onRead);
      window.removeEventListener("auth:changed", onRead);
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

      <div className="sidebar-footer" style={{ position: "relative" }}>
        <button
          type="button"
          className="user-pill"
          onClick={() => setMenuOpen((v) => !v)}
          style={{
            display: "flex", alignItems: "center", gap: 10,
            width: "100%", padding: 0, background: "transparent", border: 0,
            cursor: "pointer", textAlign: "left",
          }}
        >
          <div className="avatar" style={{ position: "relative" }}>
            {initialsOf(me?.repName)}
            {accounts.length > 1 && (
              <span style={{
                position: "absolute", top: -2, right: -2,
                background: "#3B82F6", color: "white",
                fontSize: 9, fontWeight: 700, lineHeight: 1,
                padding: "2px 4px", borderRadius: 999,
                border: "1.5px solid var(--card)",
              }}>
                {accounts.length}
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {me?.repName ?? "Signed out"}
            </span>
            <span style={{ fontSize: 11.5, color: me?.role === "admin" ? "#B45309" : "var(--text-tertiary)", fontWeight: me?.role === "admin" ? 600 : 400 }}>
              {me?.role === "admin" ? t("account.admin", locale) : me ? t("account.growth", locale) : ""}
            </span>
          </div>
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
            style={{ color: "var(--text-tertiary)", transform: menuOpen ? "rotate(180deg)" : undefined, transition: "transform 150ms" }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {menuOpen && (
          <div
            className="account-menu"
            style={{
              position: "absolute",
              bottom: "calc(100% + 8px)",
              left: 0, right: 0,
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
              overflow: "hidden",
              zIndex: 50,
            }}
          >
            <div style={{ padding: "10px 12px 6px", fontSize: 10.5, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid var(--border-light)" }}>
              {t("account.accounts", locale)}
            </div>
            {accounts.map((a) => (
              <div
                key={a.repId}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 12px",
                  background: a.active ? "var(--bg)" : "transparent",
                  borderBottom: "1px solid var(--border-light)",
                  cursor: a.active ? "default" : "pointer",
                }}
                onClick={() => !a.active && switchAccount(a.repId)}
              >
                <div className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{initialsOf(a.repName)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.repName}
                    {a.active && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: "#16a34a", fontWeight: 600 }}>● {t("account.active", locale)}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 10.5, color: a.role === "admin" ? "#B45309" : "var(--text-tertiary)", fontWeight: a.role === "admin" ? 600 : 400 }}>
                    {a.role === "admin" ? t("account.admin", locale) : t("account.growth", locale)}
                    {switching === a.repId && <span style={{ marginLeft: 6 }}>{t("account.switching", locale)}</span>}
                  </div>
                </div>
                {!a.active && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeAccount(a.repId); }}
                    title="Remove account"
                    style={{ background: "transparent", border: 0, color: "var(--text-tertiary)", cursor: "pointer", padding: 4, borderRadius: 4, lineHeight: 0 }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
            <div style={{ display: "flex", flexDirection: "column" }}>
              <Link
                href="/login?stack=1"
                onClick={() => setMenuOpen(false)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "10px 12px", fontSize: 12.5, fontWeight: 500,
                  color: "var(--blue)", textDecoration: "none",
                  borderBottom: "1px solid var(--border-light)",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="16" />
                  <line x1="8" y1="12" x2="16" y2="12" />
                </svg>
                {t("account.add", locale)}
              </Link>
              {me?.role === "admin" && (
                <Link
                  href="/settings"
                  onClick={() => setMenuOpen(false)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "10px 12px", fontSize: 12.5, fontWeight: 500,
                    color: "var(--text-secondary)", textDecoration: "none",
                    borderBottom: "1px solid var(--border-light)",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                  </svg>
                  {t("account.settings", locale)}
                </Link>
              )}
              <button
                type="button"
                onClick={logout}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "10px 12px", fontSize: 12.5, fontWeight: 500,
                  color: "var(--text-secondary)", background: "transparent",
                  border: 0, cursor: "pointer", textAlign: "left",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                {t("account.signout", locale)}
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

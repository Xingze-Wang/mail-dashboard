"use client";

/**
 * Floating missions indicator — upper-right of every authed page.
 *
 * Shows:
 *   - Nothing when there are no incomplete missions today.
 *   - A subtle red dot when 1+ missions are still incomplete today.
 *   - On click: navigates to /missions.
 *
 * Polling cadence is 60s (matches sidebar badges). The fetch is
 * cheap — /api/missions returns a small payload. Failures are
 * silent (we don't want a flaky network to spam the user with
 * an alert dot for no reason).
 *
 * Mounted from src/app/layout.tsx alongside HelpBot. Intentionally
 * does not render on /login (we check pathname) so the dot doesn't
 * appear before the user's logged in.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface MyMission {
  id: string;
  target: number;
  progress_count: number | null;
  status: string;
}

interface MissionsResponse {
  my_today: MyMission[];
}

export default function MissionsDot() {
  const pathname = usePathname();
  const [incomplete, setIncomplete] = useState(0);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [repCreatedAt, setRepCreatedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/auth/me", { credentials: "include", cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled && j.authenticated) setRepCreatedAt(j.repCreatedAt ?? null);
      } catch { /* silent */ }
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/missions", { credentials: "include", cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as MissionsResponse;
        if (cancelled) return;
        const missions = j.my_today ?? [];
        const open = missions.filter((m) => (m.progress_count ?? 0) < m.target).length;
        setIncomplete(open);
        setTotal(missions.length);
        setLoaded(true);
      } catch {
        // Silent — no dot is better than a misleading dot.
      }
    };
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!loaded) return null;
  if (pathname?.startsWith("/login")) return null;

  const isNewRep = repCreatedAt && Date.now() - new Date(repCreatedAt).getTime() < 7 * 86_400_000;

  if (total === 0 && !isNewRep) return null;

  if (total === 0 && isNewRep) {
    return (
      <Link
        href="/missions"
        style={{
          position: "fixed", top: 16, right: 16,
          padding: "6px 12px", borderRadius: 16,
          background: "rgba(100, 116, 139, 0.12)",
          border: "1px solid rgba(100, 116, 139, 0.25)",
          color: "#94a3b8", fontSize: 12, textDecoration: "none",
          display: "flex", alignItems: "center", gap: 6,
          zIndex: 50,
        }}
        title="新员工: 今日任务即将出现"
      >
        <span>📋 今日任务即将出现</span>
      </Link>
    );
  }

  if (incomplete === 0) {
    return (
      <Link
        href="/missions"
        style={{
          position: "fixed", top: 16, right: 16,
          padding: "6px 12px", borderRadius: 16,
          background: "rgba(16, 185, 129, 0.12)",
          border: "1px solid rgba(16, 185, 129, 0.25)",
          color: "#10b981", fontSize: 12, textDecoration: "none",
          display: "flex", alignItems: "center", gap: 6,
          zIndex: 50,
        }}
        title="今日任务全部完成"
      >
        <span>✅ All done</span>
      </Link>
    );
  }

  return (
    <Link
      href="/missions"
      title={`${incomplete} mission${incomplete === 1 ? "" : "s"} 待完成`}
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 50,
        // Subtle pill, not aggressive. ENFJ-supporter vibe — informs,
        // doesn't shout.
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px 5px 8px",
        borderRadius: 999,
        background: "rgba(255, 255, 255, 0.95)",
        border: "1px solid var(--border-light, #e5e7eb)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
        textDecoration: "none",
        color: "var(--text)",
        fontSize: 11,
        fontWeight: 500,
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        transition: "background 0.15s, box-shadow 0.15s",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: "#fb7185",
          boxShadow: "0 0 0 3px rgba(251, 113, 133, 0.18)",
        }}
        aria-hidden
      />
      <span style={{ color: "var(--text-secondary)" }}>
        Missions <span style={{ fontFamily: "monospace", color: "var(--text)", fontWeight: 600 }}>{total - incomplete}/{total}</span>
      </span>
    </Link>
  );
}

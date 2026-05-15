"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Target, ArrowRight } from "lucide-react";

interface MyMission {
  id: string;
  kind: string;
  target: number;
  progress_count: number;
  status: string;
}

interface TeamFocus {
  theme: string;
  congress_run_id: string | null;
}

interface MissionsResponse {
  my_today: MyMission[];
  team_focus: TeamFocus | null;
}

const KIND_LABEL: Record<string, string> = {
  send: "sends",
  reply: "replies",
  mark_wechat: "wechat",
  review_proposals: "proposals",
  review_template_edits: "template edits",
  custom: "todos",
};

/**
 * Compact one-liner pointing at /missions. Replaces an earlier
 * dark-themed banner that clashed with the dashboard's cream design
 * system. Now uses CSS vars + sits as a slim strip above the lead
 * stream — closer to a status hint than a banner.
 */
export default function MissionsBanner() {
  const [data, setData] = useState<MissionsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/missions", { credentials: "include", cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as MissionsResponse;
        if (!cancelled) {
          setData(j);
          setLoaded(true);
        }
      } catch { /* silent */ }
    };
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!loaded || !data) return null;
  const missions = data.my_today || [];
  if (missions.length === 0 && !data.team_focus) return null;

  const allDone = missions.length > 0 && missions.every((m) => (m.progress_count ?? 0) >= m.target);

  return (
    <Link
      href="/missions"
      style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "8px 14px", marginBottom: 16,
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${allDone ? "var(--green)" : "var(--blue)"}`,
        borderRadius: "var(--radius-sm)",
        textDecoration: "none",
        fontSize: 13,
        transition: "border-color 0.15s ease",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(10,10,10,0.12)"; e.currentTarget.style.borderLeftColor = allDone ? "var(--green)" : "var(--blue)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.borderLeftColor = allDone ? "var(--green)" : "var(--blue)"; }}
    >
      {allDone ? (
        <CheckCircle2 size={14} color="var(--green)" />
      ) : (
        <Target size={14} color="var(--blue)" />
      )}
      <span style={{
        fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)",
        textTransform: "uppercase", letterSpacing: "0.06em",
      }}>
        Today
      </span>
      {missions.length > 0 && (
        <span style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
          {missions.map((m, i) => (
            <span key={m.id}>
              {i > 0 && <span style={{ color: "var(--text-tertiary)", margin: "0 6px" }}>·</span>}
              <span style={{
                color: (m.progress_count ?? 0) >= m.target ? "var(--green)" : "var(--text)",
                fontWeight: 600,
              }}>
                {m.progress_count ?? 0}/{m.target}
              </span>
              <span style={{ color: "var(--text-tertiary)", marginLeft: 4 }}>
                {KIND_LABEL[m.kind] ?? m.kind}
              </span>
            </span>
          ))}
        </span>
      )}
      {data.team_focus && (
        <span style={{ marginLeft: "auto", color: "var(--text-tertiary)" }}>
          Focus: <span style={{ color: "var(--text)" }}>{data.team_focus.theme}</span>
        </span>
      )}
      <ArrowRight size={12} color="var(--text-tertiary)" style={{ marginLeft: data.team_focus ? 8 : "auto" }} />
    </Link>
  );
}

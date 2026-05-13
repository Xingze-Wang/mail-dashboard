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
  if (missions.length === 0) return null;

  const allDone = missions.every((m) => (m.progress_count ?? 0) >= m.target);

  return (
    <Link
      href="/missions"
      style={{
        display: "flex", alignItems: "center", gap: 16,
        padding: "10px 16px", marginBottom: 12,
        background: allDone ? "rgba(16, 185, 129, 0.08)" : "rgba(99, 102, 241, 0.08)",
        border: `1px solid ${allDone ? "rgba(16, 185, 129, 0.2)" : "rgba(99, 102, 241, 0.2)"}`,
        borderRadius: 8, color: "#e2e8f0",
        fontSize: 14, textDecoration: "none",
      }}
    >
      {allDone ? <CheckCircle2 size={18} color="#10b981" /> : <Target size={18} color="#818cf8" />}
      <span style={{ fontWeight: 500 }}>Today:</span>
      <span style={{ color: "#94a3b8" }}>
        {missions.map((m, i) => (
          <span key={m.id}>
            {i > 0 ? " · " : ""}
            <span style={{ color: (m.progress_count ?? 0) >= m.target ? "#10b981" : "#e2e8f0" }}>
              {m.progress_count ?? 0}/{m.target}
            </span>{" "}
            {KIND_LABEL[m.kind] ?? m.kind}
          </span>
        ))}
      </span>
      {data.team_focus ? (
        <span style={{ marginLeft: "auto", color: "#94a3b8" }}>
          Focus: <span style={{ color: "#e2e8f0" }}>{data.team_focus.theme}</span>
        </span>
      ) : <span style={{ marginLeft: "auto" }} />}
      <ArrowRight size={14} color="#64748b" />
    </Link>
  );
}

"use client";

/**
 * /missions
 *
 * Daily dashboard for sales reps. Four resolution levels:
 *
 *   1. Quarterly goal — destination
 *   2. Team focus     — path for the week (banner; what we're going for)
 *   3. My missions    — today's checklist (per-rep, with progress)
 *   4. Visibility     — what teammates are doing today (cards, headline only)
 *
 * Polls every 60s. Doesn't auto-mark complete on view — completion
 * comes from real activity (sends, replies, wechat marks) updating
 * mission_progress, not from the rep clicking a checkbox.
 *
 * Visual language matches /overview: page-title + lead-count headers,
 * stat-card primitives for counters, section-card for grouped content,
 * var(--*) tokens, inline-style layouts.
 */

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Loader2, Target, Flag, Send, MessageSquare, MessageCircle, FileText, Sparkles, CheckCircle2, Award, Sunrise } from "lucide-react";

interface QuarterlyGoal {
  id: string;
  quarter_starting: string;
  metric: string;
  target: number;
  unit: string;
  description: string | null;
}

interface TeamFocus {
  id: string;
  week_starting: string;
  theme: string;
  rationale: string | null;
  set_by: "congress" | "admin";
  status: string;
  congress_run_id: string | null;
}

interface MyMission {
  id: string;
  rep_id: number;
  due_date: string;
  kind: string;
  target: number;
  scope: Record<string, unknown> | null;
  description: string | null;
  status: string;
  generated_by: string;
  progress_count: number | null;
}

interface TeamMission {
  id: string;
  rep_id: number;
  rep_name: string;
  kind: string;
  target: number;
  progress_count: number | null;
  status: string;
}

interface MissionsResponse {
  today: string;
  week_starting: string;
  quarterly: QuarterlyGoal[];
  team_focus: TeamFocus | null;
  my_today: MyMission[];
  team_today: TeamMission[];
}

const KIND_META: Record<string, { label: string; Icon: typeof Send }> = {
  send: { label: "发邮件", Icon: Send },
  reply: { label: "回复 inbound", Icon: MessageSquare },
  mark_wechat: { label: "标记微信", Icon: MessageCircle },
  review_proposals: { label: "审 proposal", Icon: FileText },
  review_template_edits: { label: "审 template edits", Icon: FileText },
  custom: { label: "自定义", Icon: Sparkles },
};

function progressPct(count: number | null, target: number): number {
  if (!target || target <= 0) return 0;
  const c = count ?? 0;
  return Math.min(100, Math.round((c / target) * 100));
}

export default function MissionsPage() {
  const [data, setData] = useState<MissionsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/missions", { credentials: "include" });
      if (r.ok) setData((await r.json()) as MissionsResponse);
    } catch {
      // transient — next poll handles it
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
    const t = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Missions</h1>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginTop: 24 }}>
          {[1, 2, 3, 4].map((i) => <div key={i} className="skeleton" style={{ height: 92 }} />)}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div>
        <h1 className="page-title">Missions</h1>
        <p style={{ color: "var(--text-secondary)", marginTop: 12 }}>Mission system not initialized.</p>
      </div>
    );
  }

  const allDone = data.my_today.length > 0 && data.my_today.every((m) => (m.progress_count ?? 0) >= m.target);
  const totalProgress = data.my_today.reduce((s, m) => s + (m.progress_count ?? 0), 0);
  const totalTarget = data.my_today.reduce((s, m) => s + m.target, 0);
  const overallPct = totalTarget > 0 ? Math.min(100, Math.round((totalProgress / totalTarget) * 100)) : 0;
  // Headline copy — encouraging, not pressuring. Mission accomplished
  // vibes when all done; warm momentum copy when in progress; gentle
  // welcome when just starting.
  const headline = allDone
    ? "今天的 mission 都完成了 — 漂亮."
    : totalProgress === 0
      ? "新的一天开始 — 慢慢来."
      : overallPct >= 75
        ? `${overallPct}% 了 · 收尾不远了.`
        : overallPct >= 33
          ? `${overallPct}% · 节奏稳.`
          : `${overallPct}% · 一步一步来.`;

  return (
    <div>
      {/* Header — matches overview: page-title + small lead-count subtitle */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 className="page-title">今日 missions</h1>
          <span className="lead-count">{data.today}</span>
        </div>
      </div>

      {/* Encouragement strip — sets the tone for the page. Not a nag,
          a quiet acknowledgement of where you are. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, marginBottom: 20,
        padding: "10px 14px",
        background: allDone
          ? "linear-gradient(135deg, rgba(16,185,129,0.08), rgba(16,185,129,0.04))"
          : "linear-gradient(135deg, rgba(37,99,235,0.06), rgba(37,99,235,0.02))",
        border: `1px solid ${allDone ? "rgba(16,185,129,0.25)" : "var(--border-light, #e5e7eb)"}`,
        borderRadius: 8,
      }}>
        {allDone ? (
          <Award style={{ width: 18, height: 18, color: "var(--green)" }} />
        ) : totalProgress === 0 ? (
          <Sunrise style={{ width: 18, height: 18, color: "var(--blue)" }} />
        ) : (
          <Sparkles style={{ width: 18, height: 18, color: "var(--blue)" }} />
        )}
        <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text)" }}>
          {headline}
        </span>
      </div>

      {/* Quarterly goals — slim banner, destination context */}
      {data.quarterly.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
          {data.quarterly.map((g) => (
            <div
              key={g.id}
              style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "6px 12px", borderRadius: 999,
                background: "var(--bg-subtle, #f8fafc)", border: "1px solid var(--border)",
                fontSize: 12,
              }}
            >
              <Target style={{ width: 14, height: 14, color: "var(--text-tertiary)" }} />
              <span style={{ color: "var(--text-secondary)" }}>
                Q{Math.floor(new Date(g.quarter_starting).getUTCMonth() / 3) + 1}:
              </span>
              <span style={{ fontFamily: "monospace", fontWeight: 600, color: "var(--text)" }}>
                {g.target}
              </span>
              <span style={{ color: "var(--text-secondary)" }}>{g.unit} {g.metric}</span>
            </div>
          ))}
        </div>
      )}

      {/* Stat cards — top-line numbers, mirror overview's stat-card grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">Missions 今日</div>
          <div className="stat-value">{data.my_today.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">已完成</div>
          <div className="stat-value" style={{ color: "var(--green)" }}>
            {data.my_today.filter((m) => (m.progress_count ?? 0) >= m.target).length}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">总进度</div>
          <div className="stat-value">{totalProgress}<span style={{ color: "var(--text-tertiary)", fontSize: "0.6em", fontWeight: 400 }}> / {totalTarget}</span></div>
        </div>
        <div className="stat-card">
          <div className="stat-label">本周 focus</div>
          <div className="stat-value" style={{ fontSize: 13, lineHeight: 1.4, fontWeight: 500 }}>
            {data.team_focus?.theme ?? <span style={{ color: "var(--text-tertiary)" }}>未设</span>}
          </div>
        </div>
      </div>

      {/* Team focus banner — only if set, with rationale */}
      {data.team_focus && (
        <div className="section-card" style={{ marginBottom: 24, borderLeft: "3px solid var(--blue)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            <Flag style={{ width: 14, height: 14, color: "var(--blue)" }} />
            <span style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              本周 focus · week of {data.team_focus.week_starting}
            </span>
            <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>({data.team_focus.set_by})</span>
          </div>
          <h3 style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 600 }}>{data.team_focus.theme}</h3>
          {data.team_focus.rationale && (
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              {data.team_focus.rationale}
            </p>
          )}
          {data.team_focus.congress_run_id && (
            <Link
              href={`/congress/${data.team_focus.congress_run_id}/live`}
              style={{ fontSize: 12, color: "var(--blue)", display: "inline-block", marginTop: 8 }}
            >
              看 congress 推理过程 →
            </Link>
          )}
        </div>
      )}

      {/* My missions — checklist */}
      <div style={{ marginBottom: 28 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
          My missions
        </h3>
        {data.my_today.length === 0 ? (
          <div className="section-card" style={{ padding: 16, textAlign: "center" }}>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
              今天没有 mission. <Link href="/pipeline" style={{ color: "var(--blue)" }}>去 /pipeline</Link> 看看 ready leads.
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {allDone && (
              <div style={{
                padding: "16px 18px", marginBottom: 4,
                background: "linear-gradient(135deg, rgba(16,185,129,0.10), rgba(124,58,237,0.06))",
                border: "1px solid rgba(16,185,129,0.30)",
                borderRadius: 10,
                display: "flex", alignItems: "center", gap: 12,
              }}>
                <Award style={{ width: 28, height: 28, color: "var(--green)" }} />
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>
                    Mission accomplished.
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {totalProgress} actions today across {data.my_today.length} missions. 早休息一下,明天再来.
                  </div>
                </div>
              </div>
            )}
            {data.my_today.map((m) => {
              const meta = KIND_META[m.kind] ?? { label: m.kind, Icon: Sparkles };
              const Icon = meta.Icon;
              const count = m.progress_count ?? 0;
              const pct = progressPct(m.progress_count, m.target);
              const isDone = count >= m.target;
              return (
                <div
                  key={m.id}
                  className="section-card"
                  style={{
                    padding: "12px 14px",
                    borderLeft: `3px solid ${isDone ? "var(--green)" : "var(--blue)"}`,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                    <Icon style={{ width: 14, height: 14, color: isDone ? "var(--green)" : "var(--text)" }} />
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{meta.label}</span>
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-tertiary)" }}>
                      {count} / {m.target}
                    </span>
                    {isDone && <CheckCircle2 style={{ width: 14, height: 14, color: "var(--green)" }} />}
                    {m.scope && Object.keys(m.scope).length > 0 && (
                      <div style={{ display: "inline-flex", gap: 4, marginLeft: 8 }}>
                        {Object.entries(m.scope).map(([k, v]) => (
                          <span key={k} style={{
                            fontSize: 10, padding: "1px 6px", borderRadius: 6,
                            background: "var(--bg-subtle, #f1f5f9)", color: "var(--text-tertiary)",
                            fontFamily: "monospace",
                          }}>
                            {k}={String(v)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {m.description && (
                    <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55 }}>
                      {m.description}
                    </p>
                  )}
                  <div style={{
                    width: "100%", height: 4, background: "var(--bg-subtle, #f1f5f9)",
                    borderRadius: 999, overflow: "hidden",
                  }}>
                    <div style={{
                      width: `${pct}%`, height: "100%",
                      background: isDone ? "var(--green)" : "var(--blue)",
                      transition: "width 0.3s",
                    }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Team visibility — what teammates are doing */}
      {data.team_today.length > 0 && (
        <div>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
            团队今天
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
            {data.team_today.map((m) => {
              const meta = KIND_META[m.kind] ?? { label: m.kind, Icon: Sparkles };
              const Icon = meta.Icon;
              const count = m.progress_count ?? 0;
              const pct = progressPct(m.progress_count, m.target);
              const isDone = count >= m.target;
              return (
                <div
                  key={m.id}
                  className="section-card"
                  style={{
                    padding: "10px 12px",
                    borderLeft: `3px solid ${isDone ? "var(--green)" : "var(--border)"}`,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
                    <Icon style={{ width: 12, height: 12, color: "var(--text-tertiary)" }} />
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{m.rep_name}</span>
                    <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>· {meta.label}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-secondary)" }}>
                      {count}/{m.target}
                    </span>
                    <div style={{
                      flex: 1, height: 3, background: "var(--bg-subtle, #f1f5f9)",
                      borderRadius: 999, overflow: "hidden",
                    }}>
                      <div style={{
                        width: `${pct}%`, height: "100%",
                        background: isDone ? "var(--green)" : "var(--blue)",
                      }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

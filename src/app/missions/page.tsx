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

interface DailyBrief {
  goal: string;
  reasoning: string;
  bullets: string[];
  admin_overrode?: boolean;
  admin_note?: string | null;
  computed_at?: string;
}

interface MissionsResponse {
  today: string;
  week_starting: string;
  today_brief: DailyBrief | null;
  quarterly: QuarterlyGoal[];
  team_focus: TeamFocus | null;
  my_today: MyMission[];
  team_today: TeamMission[];
}

const KIND_META: Record<string, { label: string; Icon: typeof Send }> = {
  send: { label: "Send emails", Icon: Send },
  reply: { label: "Reply to inbound", Icon: MessageSquare },
  mark_wechat: { label: "Mark WeChat", Icon: MessageCircle },
  review_proposals: { label: "Review proposals", Icon: FileText },
  review_template_edits: { label: "Review template edits", Icon: FileText },
  custom: { label: "Custom", Icon: Sparkles },
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
    ? "All of today's missions done — nice."
    : totalProgress === 0
      ? "A fresh day — take it slow."
      : overallPct >= 75
        ? `${overallPct}% · almost there.`
        : overallPct >= 33
          ? `${overallPct}% · steady pace.`
          : `${overallPct}% · one step at a time.`;

  // Friendlier weekday header. "今日 missions" was bland; new copy
  // anchors on the day-of-week and uses the encouragement headline as
  // the actual H1 so the page feels less like a TODO list and more
  // like a daily plan. Pretty date in user's locale (zh-CN preferred).
  const todayDate = new Date(data.today + "T00:00:00");
  const dayOfWeekZh = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][todayDate.getDay()];
  const monthDay = `${todayDate.getMonth() + 1}/${todayDate.getDate()}`;

  return (
    <div>
      {/* Header — pretty date + the encouragement headline as the H1. */}
      <div style={{ marginBottom: 20 }}>
        <div style={{
          fontSize: 11, color: "var(--text-tertiary)",
          textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4,
        }}>
          {dayOfWeekZh} · {monthDay}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {allDone ? (
            <Award style={{ width: 24, height: 24, color: "var(--green)" }} />
          ) : totalProgress === 0 ? (
            <Sunrise style={{ width: 24, height: 24, color: "var(--blue)" }} />
          ) : (
            <Sparkles style={{ width: 24, height: 24, color: "var(--blue)" }} />
          )}
          <h1 className="page-title" style={{ margin: 0 }}>{headline}</h1>
        </div>
      </div>

      {/* Today's narrative brief — LLM-written nightly, surfaces what
          matters today + 2-3 tactical bullets. Hidden gracefully if
          the cron hasn't fired yet or LLM failed (no brief row). */}
      {data.today_brief && (
        <div className="section-card" style={{
          padding: 20, marginBottom: 16,
          borderLeft: "3px solid var(--blue)",
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)",
            textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8,
          }}>
            Today {data.today_brief.admin_overrode && (
              <span style={{ color: "var(--gold)", marginLeft: 6 }}>(admin edited)</span>
            )}
          </div>
          <div style={{
            fontFamily: "var(--font-heading)", fontSize: 18,
            color: "var(--text)", marginBottom: 8, letterSpacing: "-0.01em",
            lineHeight: 1.35,
          }}>
            {data.today_brief.goal}
          </div>
          <div style={{
            fontSize: 13, color: "var(--text-secondary)",
            lineHeight: 1.55, marginBottom: data.today_brief.bullets.length > 0 ? 12 : 0,
          }}>
            {data.today_brief.reasoning}
          </div>
          {data.today_brief.bullets.length > 0 && (
            <ul style={{
              margin: 0, paddingLeft: 18, listStyle: "disc",
              fontSize: 13, color: "var(--text)", lineHeight: 1.6,
            }}>
              {data.today_brief.bullets.map((b, i) => (
                <li key={i} style={{ marginBottom: 2 }}>{b}</li>
              ))}
            </ul>
          )}
          {data.today_brief.admin_note && (
            <div style={{
              marginTop: 12, padding: "8px 12px",
              background: "var(--gold-bg)", borderLeft: "2px solid var(--gold)",
              borderRadius: "0 4px 4px 0",
              fontSize: 12, color: "var(--gold)",
            }}>
              <strong>Admin:</strong> {data.today_brief.admin_note}
            </div>
          )}
        </div>
      )}

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

      {/* Headline progress bar — one big number, one big bar, the
          per-pool breakdown as small chips. Less cluttered than the
          4-stat-card grid; the number that matters is "did I do
          today's quota yet?". */}
      <div style={{
        background: "white", border: "1px solid var(--border)", borderRadius: 12,
        padding: "16px 18px", marginBottom: 24,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
          <div>
            <span style={{ fontSize: 32, fontWeight: 700, color: "var(--text)" }}>{totalProgress}</span>
            <span style={{ fontSize: 18, color: "var(--text-tertiary)", marginLeft: 4 }}>/ {totalTarget}</span>
            <span style={{ fontSize: 13, color: "var(--text-secondary)", marginLeft: 10 }}>done today</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {(() => {
              // Derive the per-pool breakdown from the send-mission's scope.
              // The mission scope.per_pool tells the rep "you have 30 cn, 20 overseas".
              const sendMission = data.my_today.find((m) => m.kind === "send");
              const pp = (sendMission?.scope as { per_pool?: Record<string, number> } | null)?.per_pool;
              if (!pp) return null;
              const POOL_LABEL: Record<string, string> = {
                strong: "strong",
                normal_cn: ".cn",
                normal_overseas: "overseas",
                normal_edu: ".edu",
              };
              const POOL_COLOR: Record<string, string> = {
                strong: "#7c3aed",
                normal_cn: "#dc2626",
                normal_overseas: "#0ea5e9",
                normal_edu: "#059669",
              };
              return Object.entries(pp)
                .filter(([, v]) => (v as number) > 0)
                .map(([k, v]) => (
                  <span
                    key={k}
                    title={POOL_LABEL[k] ?? k}
                    style={{
                      fontSize: 11, padding: "3px 9px", borderRadius: 999,
                      background: (POOL_COLOR[k] ?? "#64748b") + "18",
                      color: POOL_COLOR[k] ?? "#64748b", fontWeight: 600,
                      border: `1px solid ${(POOL_COLOR[k] ?? "#64748b") + "44"}`,
                    }}
                  >
                    {POOL_LABEL[k] ?? k}: {v as number}
                  </span>
                ));
            })()}
          </div>
        </div>
        <div style={{
          height: 8, borderRadius: 999, background: "var(--bg-subtle, #f1f5f9)",
          overflow: "hidden", position: "relative",
        }}>
          <div style={{
            position: "absolute", inset: 0,
            width: `${overallPct}%`,
            background: allDone ? "var(--green, #10b981)" : "var(--blue, #2563eb)",
            transition: "width 0.4s ease",
          }} />
        </div>
        <div style={{
          marginTop: 8, fontSize: 11, color: "var(--text-tertiary)",
          display: "flex", justifyContent: "space-between",
        }}>
          <span>
            {data.my_today.filter((m) => (m.progress_count ?? 0) >= m.target).length} / {data.my_today.length} missions complete
          </span>
          <span>
            {data.team_focus?.theme ?? "(no focus set this week)"}
          </span>
        </div>
      </div>

      {/* Quarterly goals were here in the old layout, but they're
          destination context, not daily — moved below the progress bar
          so the actionable thing (today's progress) is the first beat. */}

      {/* Team focus banner — only if set, with rationale */}
      {data.team_focus && (
        <div className="section-card" style={{ marginBottom: 24, borderLeft: "3px solid var(--blue)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            <Flag style={{ width: 14, height: 14, color: "var(--blue)" }} />
            <span style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              focus this week · week of {data.team_focus.week_starting}
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
              See congress reasoning →
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
          <section style={{
            padding: 20, marginTop: 16, border: "1px solid #1e293b",
            borderRadius: 8, color: "#94a3b8", fontSize: 13,
          }}>
            {data.team_focus?.status === "proposed" ? (
              <>This week&apos;s missions are still waiting on admin approval. Ping admin, or check back in 1-2 hours.</>
            ) : (
              <>No missions yet today. The system generates them at 7am Beijing and allocates leads at 9am. If it&apos;s still empty by 9:30, ping admin to check your daily quota.</>
            )}
          </section>
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
                    {totalProgress} actions today across {data.my_today.length} missions. Rest up — see you tomorrow.
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
            Team today
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

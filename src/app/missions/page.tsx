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

interface TeamBrief {
  rep_id: number;
  rep_name: string;
  goal: string;
  reasoning: string;
  bullets: string[];
}

interface MissionsResponse {
  today: string;
  week_starting: string;
  today_brief: DailyBrief | null;     // populated for sales reps
  team_briefs: TeamBrief[];           // populated for admin (all reps)
  quarterly: QuarterlyGoal[];
  team_focus: TeamFocus | null;
  my_today: MyMission[];
  team_today: TeamMission[];
  role?: string;
  is_admin?: boolean;
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

  // Admin sees the team-overview cards regardless of whether
  // daily_rep_brief has rows for today — the cron may not have run yet,
  // and TeamOverviewSection fetches its own data. Falling back to
  // team_briefs.length > 0 hid the entire admin section on days when
  // briefs hadn't materialized. Trust the server's role flag instead.
  const isAdminView = !!data.is_admin || (!!data.team_briefs && data.team_briefs.length > 0);

  const allDone = data.my_today.length > 0 && data.my_today.every((m) => (m.progress_count ?? 0) >= m.target);
  const totalProgress = data.my_today.reduce((s, m) => s + (m.progress_count ?? 0), 0);
  const totalTarget = data.my_today.reduce((s, m) => s + m.target, 0);
  const overallPct = totalTarget > 0 ? Math.min(100, Math.round((totalProgress / totalTarget) * 100)) : 0;

  // Headline copy — split admin vs rep. Admin sees a team-state summary
  // (rendered after team-grid loads, so we use a calm placeholder here
  // and let the grid carry the real signal). Rep sees their own progress
  // encouragement.
  const headline = isAdminView
    ? "Team today"
    : allDone
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
          {!isAdminView && (
            allDone ? (
              <Award style={{ width: 24, height: 24, color: "var(--green)" }} />
            ) : totalProgress === 0 ? (
              <Sunrise style={{ width: 24, height: 24, color: "var(--blue)" }} />
            ) : (
              <Sparkles style={{ width: 24, height: 24, color: "var(--blue)" }} />
            )
          )}
          <h1 className="page-title" style={{ margin: 0 }}>{headline}</h1>
        </div>
      </div>

      {/* Admin view: management-game team grid. Rich cards w/ health
          badges. Click any card to drill in. Renders whenever the
          session role is admin — TeamOverviewSection fetches its own
          data and tolerates an empty daily_rep_brief table. */}
      {isAdminView && <TeamOverviewSection />}

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

      {/* My missions — rep-only checklist. Admin doesn't have per-rep
          missions; their team grid above carries that signal. */}
      {!isAdminView && (
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
      )}

      {/* Team visibility — peer view of what teammates are doing.
          Hidden for admins (they get the richer Team Overview grid
          at the top of the page, with drill-in). */}
      {data.team_today.length > 0 && !isAdminView && (
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

// ─── Admin team-overview cards (management-game vibe) ──────────────

interface RepOverviewCard {
  rep_id: number;
  rep_name: string;
  role: string;
  today_goal: string | null;
  today_reasoning: string | null;
  today_bullets: string[];
  sent_7d: number;
  replied_7d: number;
  wechat_7d: number;
  ready_queue: number;
  sends_today: number;
  missions_total: number;
  missions_done: number;
  last_activity_at: string | null;
  recent_escalations_7d: number;
  recent_learnings_7d: number;
  health: "healthy" | "watch" | "stuck";
  health_reason: string;
}

const HEALTH_COLOR: Record<RepOverviewCard["health"], { bg: string; border: string; text: string; dot: string }> = {
  healthy: { bg: "var(--green-bg)", border: "var(--green)", text: "var(--green)", dot: "var(--green)" },
  watch:   { bg: "var(--gold-bg)",  border: "var(--gold)",  text: "var(--gold)",  dot: "var(--gold)" },
  stuck:   { bg: "var(--coral-bg)", border: "var(--coral)", text: "var(--coral)", dot: "var(--coral)" },
};

function TeamOverviewSection() {
  const [reps, setReps] = useState<RepOverviewCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [drillRepId, setDrillRepId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/admin/team-overview", { credentials: "include", cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) setReps(j.reps ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const iv = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  if (loading) {
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
          {[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 160, borderRadius: 10 }} />)}
        </div>
      </div>
    );
  }
  if (reps.length === 0) {
    // Was: return null. That hid the entire admin view when
    // /api/admin/team-overview returned an empty list, which happens
    // when the daily-rep-brief cron hasn't run yet OR every rep has
    // no missions today. Now we render an honest empty-state so the
    // admin sees "the system is alive, just nothing to show yet."
    return (
      <div style={{
        marginBottom: 20, padding: 16, borderRadius: 10,
        border: "1px dashed var(--border)",
        color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.55,
      }}>
        No team data yet for today. The team-overview rolls up
        <code style={{ margin: "0 4px" }}>daily_rep_brief</code> + active missions,
        which materialize after the morning cron (~09:00 Beijing). Check back later,
        or trigger <code>/api/cron/daily-rep-brief</code> manually if needed.
      </div>
    );
  }

  // Health-sorted: stuck → watch → healthy (so the attention items are
  // on top of the page, where admin's eye lands first).
  const sorted = [...reps].sort((a, b) => {
    const rank = { stuck: 0, watch: 1, healthy: 2 } as const;
    return rank[a.health] - rank[b.health];
  });
  const stuckCount = reps.filter((r) => r.health === "stuck").length;
  const watchCount = reps.filter((r) => r.health === "watch").length;

  return (
    <div style={{ marginBottom: 20 }}>
      {/* Inline status summary — admin's first-glance signal */}
      {(stuckCount > 0 || watchCount > 0) && (
        <div style={{
          fontSize: 12, color: "var(--text-secondary)", marginBottom: 12,
          display: "flex", gap: 12, alignItems: "center",
        }}>
          {stuckCount > 0 && (
            <span style={{ color: "var(--coral)" }}>
              <strong>{stuckCount}</strong> stuck
            </span>
          )}
          {watchCount > 0 && (
            <span style={{ color: "var(--gold)" }}>
              <strong>{watchCount}</strong> need a look
            </span>
          )}
          <span style={{ color: "var(--text-tertiary)" }}>
            · click any card to drill in
          </span>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        {sorted.map((r) => <RepCard key={r.rep_id} rep={r} onClick={() => setDrillRepId(r.rep_id)} />)}
      </div>
      {drillRepId != null && <RepDrillModal repId={drillRepId} onClose={() => setDrillRepId(null)} />}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)",
      textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10,
    }}>{children}</div>
  );
}

function RepCard({ rep, onClick }: { rep: RepOverviewCard; onClick: () => void }) {
  const c = HEALTH_COLOR[rep.health];
  const lastActHours = rep.last_activity_at
    ? Math.round((Date.now() - new Date(rep.last_activity_at).getTime()) / 3_600_000)
    : null;
  return (
    <button
      onClick={onClick}
      className="section-card"
      style={{
        padding: 16, textAlign: "left", cursor: "pointer",
        width: "100%", border: "1px solid var(--border)",
        borderLeft: `3px solid ${c.border}`,
        background: "var(--card)",
        transition: "all 0.15s ease",
        fontFamily: "inherit",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = c.border; e.currentTarget.style.boxShadow = "var(--shadow-md)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.boxShadow = "var(--shadow-sm)"; }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot, display: "inline-block" }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{rep.rep_name}</span>
          <span style={{ fontSize: 10, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{rep.role}</span>
        </div>
      </div>
      {rep.today_goal && (
        <div style={{
          fontFamily: "var(--font-heading)", fontSize: 14,
          color: "var(--text)", marginBottom: 8, lineHeight: 1.35,
          letterSpacing: "-0.01em",
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>
          {rep.today_goal}
        </div>
      )}
      {/* KPI stats */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4,
        marginBottom: 8, fontFamily: "var(--font-heading)",
      }}>
        <Stat label="Sends 7d" value={rep.sent_7d} />
        <Stat label="Replies" value={rep.replied_7d} />
        <Stat label="WeChat" value={rep.wechat_7d} valueColor="var(--green)" />
      </div>
      {/* Bottom strip: health reason + ready queue */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        fontSize: 11, color: c.text, paddingTop: 8, borderTop: "1px solid var(--border-light)",
      }}>
        <span style={{ fontWeight: 500 }}>{rep.health_reason}</span>
        <span style={{ color: "var(--text-tertiary)" }}>
          {rep.ready_queue} ready
          {lastActHours != null && lastActHours < 9999 && (
            <> · {lastActHours < 1 ? "<1h" : lastActHours < 24 ? `${lastActHours}h` : `${Math.round(lastActHours / 24)}d`} ago</>
          )}
        </span>
      </div>
    </button>
  );
}

function Stat({ label, value, valueColor }: { label: string; value: number; valueColor?: string }) {
  return (
    <div>
      <div style={{
        fontSize: 18, fontWeight: 600, color: valueColor ?? "var(--text)",
        letterSpacing: "-0.02em", lineHeight: 1,
      }}>{value}</div>
      <div style={{ fontSize: 10, color: "var(--text-tertiary)", letterSpacing: "0.04em", marginTop: 2 }}>{label}</div>
    </div>
  );
}

interface RepDrillData {
  today: string;
  rep: { id: number; name: string; role: string; email: string };
  brief: { goal: string; reasoning: string; bullets: string[] } | null;
  missions: Array<{ kind: string; target: number; progress: number; description: string | null }>;
  recent_emails: Array<{ id: string; status: string; subject: string; recipient: string; created_at: string }>;
  recent_escalations: Array<{ raw_text: string; asked_at: string }>;
  learnings: Array<{ kind: string; body: string; created_at: string }>;
  recent_inbound: Array<{ sender: string; subject: string; snippet: string; received_at: string }>;
  recent_wechat: Array<{ recipient: string; paper_title: string; wechat_at: string }>;
}

function RepDrillModal({ repId, onClose }: { repId: number; onClose: () => void }) {
  const [data, setData] = useState<RepDrillData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/team-overview/${repId}`, { credentials: "include" })
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setData(j); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repId]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
        zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "60px 20px", overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--card)", borderRadius: "var(--radius)",
          maxWidth: 720, width: "100%", boxShadow: "var(--shadow-md)",
          padding: "24px 28px", maxHeight: "85vh", overflowY: "auto",
        }}
      >
        {loading || !data ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--text-tertiary)" }}>Loading…</div>
        ) : (() => {
          // Have we got ANY 7d-window content to show below the stats? If
          // not, we render an explicit "quiet week" hint so the modal never
          // collapses to just a header (the 2026-05-19 bug — modal popped
          // open empty because all sections gated on length>0).
          const hasAnyContent = !!data.brief
            || data.missions.length > 0
            || data.recent_emails.length > 0
            || data.recent_inbound.length > 0
            || data.recent_wechat.length > 0
            || data.recent_escalations.length > 0
            || data.learnings.length > 0;
          return (
          <>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
              <div>
                <div style={{
                  fontFamily: "var(--font-heading)", fontSize: 24, fontWeight: 600,
                  letterSpacing: "-0.02em", color: "var(--text)",
                }}>
                  {data.rep.name}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>
                  {data.rep.role} · {data.rep.email}
                </div>
              </div>
              <button onClick={onClose} style={{
                background: "none", border: "none", fontSize: 24, color: "var(--text-tertiary)",
                cursor: "pointer", lineHeight: 1, padding: "0 4px",
              }}>×</button>
            </div>

            {/* Always-shown 7d snapshot — the drill modal used to render
                nothing when all sections were length=0 (rep had no missions
                today + quiet week → blank dialog). This grid gives at minimum
                a 5-number snapshot so the modal always communicates. */}
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12,
              padding: "14px 0", borderTop: "1px solid var(--border-light)",
              borderBottom: "1px solid var(--border-light)", marginBottom: 18,
              fontFamily: "var(--font-heading)",
            }}>
              <Stat label="Missions today" value={data.missions.length} />
              <Stat label="Sends 7d" value={data.recent_emails.length} />
              <Stat label="Replies 7d" value={data.recent_inbound.length} />
              <Stat label="WeChat 7d" value={data.recent_wechat.length} valueColor={data.recent_wechat.length > 0 ? "var(--green)" : undefined} />
              <Stat label="Leon learned" value={data.learnings.length} />
            </div>

            {!hasAnyContent && (
              <div style={{
                textAlign: "center", padding: "28px 16px", color: "var(--text-tertiary)",
                fontSize: 13, lineHeight: 1.6,
                background: "var(--background-secondary)", borderRadius: "var(--radius)",
                marginBottom: 18,
              }}>
                <div style={{ fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
                  Quiet week for {data.rep.name}
                </div>
                No missions today, no sends, no replies, no WeChat conversions in the last 7 days.
                {data.rep.role === "sales" && (
                  <div style={{ marginTop: 10, fontSize: 12 }}>
                    If allocator missed this rep, check <code>/admin/missions</code> for daily quota config.
                  </div>
                )}
              </div>
            )}

            {data.brief && (
              <Block title="Today">
                <div style={{
                  fontFamily: "var(--font-heading)", fontSize: 16,
                  color: "var(--text)", marginBottom: 6, lineHeight: 1.35,
                }}>{data.brief.goal}</div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 8 }}>
                  {data.brief.reasoning}
                </div>
                {data.brief.bullets.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
                    {data.brief.bullets.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                )}
              </Block>
            )}

            {data.missions.length > 0 && (
              <Block title="Today's missions">
                {data.missions.map((m, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "6px 0", borderBottom: i < data.missions.length - 1 ? "1px solid var(--border-light)" : "none",
                    fontSize: 13,
                  }}>
                    <span style={{ color: "var(--text)" }}>{m.description || m.kind}</span>
                    <span style={{ fontFamily: "monospace", color: m.progress >= m.target ? "var(--green)" : "var(--text-secondary)" }}>
                      {m.progress} / {m.target}
                    </span>
                  </div>
                ))}
              </Block>
            )}

            {data.recent_emails.length > 0 && (
              <Block title="Last 15 sends">
                {data.recent_emails.slice(0, 8).map((e) => (
                  <DrillRow key={e.id}
                    left={e.subject?.slice(0, 60) || "(no subject)"}
                    right={`${e.status} · ${new Date(e.created_at).toLocaleString()}`}
                  />
                ))}
              </Block>
            )}

            {data.recent_inbound.length > 0 && (
              <Block title="Recent replies in">
                {data.recent_inbound.map((m, i) => (
                  <DrillRow key={i}
                    left={`${m.sender} — ${m.subject?.slice(0, 50) || ""}`}
                    right={new Date(m.received_at).toLocaleString()}
                  />
                ))}
              </Block>
            )}

            {data.recent_wechat.length > 0 && (
              <Block title="Recent WeChat conversions">
                {data.recent_wechat.map((w, i) => (
                  <DrillRow key={i}
                    left={`${w.recipient}: ${w.paper_title?.slice(0, 50) || ""}`}
                    right={new Date(w.wechat_at).toLocaleString()}
                  />
                ))}
              </Block>
            )}

            {data.recent_escalations.length > 0 && (
              <Block title="Recent escalations to Leon">
                {data.recent_escalations.map((e, i) => (
                  <DrillRow key={i}
                    left={e.raw_text.slice(0, 80)}
                    right={new Date(e.asked_at).toLocaleString()}
                  />
                ))}
              </Block>
            )}

            {data.learnings.length > 0 && (
              <Block title="What Leon learned about this rep">
                {data.learnings.map((l, i) => (
                  <DrillRow key={i} left={`[${l.kind}] ${l.body.slice(0, 80)}`} right="" />
                ))}
              </Block>
            )}
          </>
          );
        })()}
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)",
        textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8,
      }}>{title}</div>
      <div>{children}</div>
    </div>
  );
}

function DrillRow({ left, right }: { left: string; right: string }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "5px 0", fontSize: 12, gap: 12,
      borderBottom: "1px solid var(--border-light)",
    }}>
      <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{left}</span>
      <span style={{ color: "var(--text-tertiary)", whiteSpace: "nowrap", fontSize: 11 }}>{right}</span>
    </div>
  );
}

"use client";

/**
 * /admin/missions
 *
 * Admin approval surface for proposed team_focus + missions.
 *
 * Bulk approval is the design point — synthesizer emits
 * 5 reps × 5 days × 2 mission kinds = 50 rows.
 * Admin shouldn't click 50 times.
 *
 * Visual matches /overview: section-card containers, page-title +
 * lead-count subtitle, var(--*) tokens, inline-style layout.
 */

import { useEffect, useState, useCallback } from "react";
import { Loader2, AlertCircle, Check, X, Calendar, Flag } from "lucide-react";

interface Focus {
  id: string;
  week_starting: string;
  theme: string;
  rationale: string | null;
  set_by: "congress" | "admin";
  status: "proposed" | "active" | "rejected" | "archived";
  congress_run_id: string | null;
}

interface Mission {
  id: string;
  rep_id: number;
  rep_name: string;
  due_date: string;
  kind: string;
  target: number;
  scope: Record<string, unknown> | null;
  description: string | null;
  generated_by: string;
  team_focus_id: string | null;
  status: string;
}

interface AdminMissionsResponse {
  focuses: Focus[];
  missions: Mission[];
}

export default function AdminMissionsPage() {
  const [data, setData] = useState<AdminMissionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/missions", { credentials: "include" });
      if (r.status === 403) { setAuthError(true); return; }
      if (!r.ok) return;
      setData((await r.json()) as AdminMissionsResponse);
    } catch {
      // transient
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const action = useCallback(async (kind: string, payload: Record<string, unknown>) => {
    setBusy(`${kind}:${JSON.stringify(payload)}`);
    try {
      const r = await fetch("/api/admin/missions", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: kind, ...payload }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        alert(`Action failed: ${e.error ?? r.status}`);
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  if (authError) {
    return (
      <div>
        <div className="section-card" style={{ maxWidth: 640, margin: "60px auto", padding: 32, textAlign: "center" }}>
          <AlertCircle style={{ width: 36, height: 36, color: "var(--coral)", margin: "0 auto 12px" }} />
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Admin only</h1>
        </div>
      </div>
    );
  }
  if (loading || !data) {
    return (
      <div>
        <h1 className="page-title">Mission system</h1>
        <div style={{ marginTop: 24, textAlign: "center" }}>
          <Loader2 style={{ width: 20, height: 20, color: "var(--text-tertiary)", animation: "spin 1s linear infinite", margin: "0 auto" }} />
        </div>
      </div>
    );
  }

  const proposedFocuses = data.focuses.filter((f) => f.status === "proposed");
  const activeFocuses = data.focuses.filter((f) => f.status === "active");

  // Group proposed missions by week_starting (Monday before due_date).
  const mondayOf = (iso: string): string => {
    const d = new Date(iso + "T00:00:00Z");
    const day = d.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    d.setUTCDate(d.getUTCDate() - diff);
    return d.toISOString().slice(0, 10);
  };
  const proposedMissions = data.missions.filter((m) => m.status === "proposed");
  const byWeek = new Map<string, Mission[]>();
  for (const m of proposedMissions) {
    const k = mondayOf(m.due_date);
    byWeek.set(k, [...(byWeek.get(k) ?? []), m]);
  }
  const sortedWeeks = [...byWeek.keys()].sort();
  const activeMissions = data.missions.filter((m) => m.status === "active");

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 className="page-title">Mission system</h1>
          <span className="lead-count">admin · 审核 + bulk-approve</span>
        </div>
      </div>

      {/* Stat cards — quick scan of the queue */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 28 }}>
        <div className="stat-card">
          <div className="stat-label">待审核 focus</div>
          <div className="stat-value" style={{ color: proposedFocuses.length > 0 ? "var(--blue)" : undefined }}>
            {proposedFocuses.length}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">待审核 missions</div>
          <div className="stat-value" style={{ color: proposedMissions.length > 0 ? "var(--blue)" : undefined }}>
            {proposedMissions.length}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active focus</div>
          <div className="stat-value" style={{ color: "var(--green)" }}>{activeFocuses.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active missions</div>
          <div className="stat-value" style={{ color: "var(--green)" }}>{activeMissions.length}</div>
        </div>
      </div>

      {/* Proposed team focuses */}
      {proposedFocuses.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
            待审核 team focus
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {proposedFocuses.map((f) => {
              const weekMissions = data.missions.filter(
                (m) => m.team_focus_id === f.id && m.status === "proposed",
              );
              const isBusy = busy?.includes(f.id);
              return (
                <div key={f.id} className="section-card" style={{ padding: 16, borderLeft: "3px solid var(--blue)" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                    <Flag style={{ width: 14, height: 14, color: "var(--blue)" }} />
                    <span style={{ fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                      week of {f.week_starting}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>({f.set_by})</span>
                  </div>
                  <h3 style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 600 }}>{f.theme}</h3>
                  {f.rationale && (
                    <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                      {f.rationale}
                    </p>
                  )}
                  <p style={{ fontSize: 11, color: "var(--text-tertiary)", margin: "0 0 12px" }}>
                    <Calendar style={{ width: 11, height: 11, display: "inline", verticalAlign: "middle" }} />
                    {" "}{weekMissions.length} 个 mission rows tied to this focus
                  </p>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => void action("approve_focus", { focus_id: f.id })}
                      disabled={isBusy}
                      className="btn"
                      style={{ background: "var(--green)", color: "white", borderColor: "var(--green)", fontSize: 12 }}
                    >
                      <Check style={{ width: 12, height: 12 }} /> Approve focus
                    </button>
                    <button
                      onClick={() => void action("reject_focus", { focus_id: f.id })}
                      disabled={isBusy}
                      className="btn"
                      style={{ fontSize: 12 }}
                    >
                      <X style={{ width: 12, height: 12 }} /> Reject
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Proposed missions, grouped by week */}
      {sortedWeeks.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
            待审核 missions (按周)
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {sortedWeeks.map((week) => {
              const ms = byWeek.get(week) ?? [];
              const repCount = new Set(ms.map((m) => m.rep_id)).size;
              const isBusy = busy?.includes(week);
              return (
                <div key={week} className="section-card" style={{ padding: 14, borderLeft: "3px solid var(--coral)" }}>
                  <div style={{
                    display: "flex", alignItems: "baseline", justifyContent: "space-between",
                    gap: 8, marginBottom: 12, flexWrap: "wrap",
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      Week of {week}{" "}
                      <span style={{ fontWeight: 400, color: "var(--text-tertiary)" }}>
                        · {ms.length} missions across {repCount} reps
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        onClick={() => void action("approve_missions", { week_starting: week })}
                        disabled={isBusy}
                        className="btn"
                        style={{ background: "var(--green)", color: "white", borderColor: "var(--green)", fontSize: 12 }}
                      >
                        <Check style={{ width: 12, height: 12 }} /> Approve all {ms.length}
                      </button>
                      <button
                        onClick={() => void action("reject_missions", { week_starting: week })}
                        disabled={isBusy}
                        className="btn"
                        style={{ fontSize: 12 }}
                      >
                        <X style={{ width: 12, height: 12 }} /> Reject all
                      </button>
                    </div>
                  </div>
                  {/* Mission preview — collapsed */}
                  <div style={{
                    display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 6,
                  }}>
                    {ms.slice(0, 12).map((m) => (
                      <div key={m.id} style={{
                        fontSize: 11, padding: "5px 8px",
                        background: "var(--bg-subtle, #f8fafc)", borderRadius: 4,
                        border: "1px solid var(--border-light, #e5e7eb)",
                      }}>
                        <span style={{ fontWeight: 600 }}>{m.rep_name}</span>
                        <span style={{ color: "var(--text-tertiary)" }}> · {m.due_date.slice(5)} · {m.kind} ×{m.target}</span>
                      </div>
                    ))}
                    {ms.length > 12 && (
                      <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic", padding: "5px 8px" }}>
                        +{ms.length - 12} more…
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Active state — context */}
      {(activeFocuses.length > 0 || activeMissions.length > 0) && (
        <div>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
            当前 active
          </h3>
          {activeFocuses.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
              {activeFocuses.map((f) => (
                <div key={f.id} className="section-card" style={{
                  padding: "10px 14px", borderLeft: "3px solid var(--green)",
                }}>
                  <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>week {f.week_starting} · </span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{f.theme}</span>
                </div>
              ))}
            </div>
          )}
          <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
            {activeMissions.length} active missions across the team. Reps see their own at{" "}
            <a href="/missions" style={{ color: "var(--blue)" }}>/missions</a>.
          </p>
        </div>
      )}

      {(proposedFocuses.length === 0 && sortedWeeks.length === 0 && activeFocuses.length === 0 && activeMissions.length === 0) && (
        <div className="section-card" style={{ padding: 24, textAlign: "center" }}>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
            还没有 proposed 或 active 的 missions. 等下次 weekly congress 跑出提议, 或者{" "}
            <a href="/api/missions/heuristic-seed" style={{ color: "var(--blue)" }}>POST /api/missions/heuristic-seed</a>
            {" "}临时种几个.
          </p>
        </div>
      )}
    </div>
  );
}

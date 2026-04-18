"use client";

import { Globe, MapPin, Crown } from "lucide-react";
import { Analytics } from "./types";
import { paletteFor, initialsFor } from "./repColors";

const TIER_ORDER: Record<string, number> = { strong: 0, normal: 1 };

/** Static ownership rules — kept in sync with assignment.ts (SALES_RULES.md). */
const OWNERSHIP_RULES: Array<{
  match: (name: string) => boolean;
  icon: typeof Crown;
  label: string;
  scope: string;
  detail: string;
}> = [
  {
    match: (n) => n.toLowerCase() === "leo",
    icon: Crown,
    label: "Leo",
    scope: "Strong leads",
    detail: "citation_count > 2000 OR school_tier ≤ 2",
  },
  {
    match: (n) => n.toLowerCase() === "ethan",
    icon: Globe,
    label: "Ethan",
    scope: "Normal · overseas",
    detail: "email domain does NOT end with .cn",
  },
  {
    match: (n) => n.toLowerCase() === "chenyu",
    icon: MapPin,
    label: "Chenyu",
    scope: "Normal · domestic",
    detail: "email domain ends with .cn",
  },
];

export function SalesTab({ analytics }: { analytics: Analytics }) {
  // Sort: order by rep id (stable) and only render reps that have at least one
  // assigned lead OR are referenced in the static ownership rules above (so
  // a freshly added rep with zero assignments still appears).
  const reps = [...analytics.sales.reps].sort((a, b) => a.rep.id - b.rep.id);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* ── Per-rep cards ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        {reps.map((r) => {
          const palette = paletteFor(r.rep.name);
          const sendRate = r.assigned > 0 ? Math.round((r.sent / r.assigned) * 100) : 0;
          return (
            <div key={r.rep.id} className="section-card" style={{ padding: 24, borderTop: `3px solid ${palette.solid}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
                <div
                  style={{
                    width: 40, height: 40, borderRadius: 20,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 14, fontWeight: 600,
                    background: palette.bg, color: palette.color,
                  }}
                >
                  {initialsFor(r.rep.name)}
                </div>
                <div>
                  <div style={{ fontFamily: "var(--font-heading)", fontSize: 16, fontWeight: 600, color: "#1A1A1A" }}>{r.rep.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>{r.rep.sender_email}</div>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
                {[
                  { label: "Assigned", value: r.assigned },
                  { label: "Sent",     value: r.sent },
                  { label: "WeChat",   value: r.wechat, color: "var(--green)" },
                  { label: "Conv.",    value: `${r.convRate}%`, color: "var(--green)" },
                ].map((s) => (
                  <div key={s.label}>
                    <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      {s.label}
                    </div>
                    <div style={{ fontFamily: "var(--font-heading)", fontSize: 20, fontWeight: 600, color: s.color || "#1A1A1A" }}>
                      {s.value}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ height: 6, background: "var(--bg)", borderRadius: 3, border: "1px solid var(--border-light)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${sendRate}%`, background: palette.bar, borderRadius: 3, transition: "width 0.3s ease" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11, color: "var(--text-tertiary)", fontWeight: 500 }}>
                <span>Send rate: {sendRate}%</span>
                <span>{r.sent} / {r.assigned}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Ownership rules card (replaces the old "category coverage") ── */}
      <div className="section-card" style={{ padding: 0 }}>
        <h3 style={{ padding: "20px 24px", marginBottom: 0, borderBottom: "1px solid var(--border)" }}>
          Ownership Rules
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 0 }}>
          {OWNERSHIP_RULES.map((rule, idx) => {
            const palette = paletteFor(rule.label);
            const Icon = rule.icon;
            const isLast = idx === OWNERSHIP_RULES.length - 1;
            return (
              <div
                key={rule.label}
                style={{
                  padding: "20px 24px",
                  borderRight: isLast ? "none" : "1px solid var(--border-light)",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                }}
              >
                <div
                  style={{
                    width: 32, height: 32, borderRadius: 16,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: palette.bg, color: palette.color,
                    flexShrink: 0,
                  }}
                >
                  <Icon style={{ width: 16, height: 16 }} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--font-heading)", fontSize: 14, fontWeight: 600, color: palette.color, marginBottom: 2 }}>
                    {rule.label}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
                    {rule.scope}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.45 }}>
                    {rule.detail}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Per-tier performance table ── */}
      <div className="section-card" style={{ padding: 0 }}>
        <h3 style={{ padding: "20px 24px", marginBottom: 0, borderBottom: "1px solid var(--border)" }}>
          Rep × Lead Type Performance
        </h3>
        <table className="data-table">
          <thead>
            <tr>
              {["Rep", "Tier", "Assigned", "Sent", "Replied", "WeChat", "Conv %"].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {reps
              .flatMap((r) =>
                r.tiers
                  .filter((t) => t.assigned > 0)
                  .map((t) => ({ r, t })),
              )
              // sort by rep.id then tier (strong first)
              .sort((a, b) => {
                if (a.r.rep.id !== b.r.rep.id) return a.r.rep.id - b.r.rep.id;
                return (TIER_ORDER[a.t.tier] ?? 9) - (TIER_ORDER[b.t.tier] ?? 9);
              })
              .map(({ r, t }) => {
                const palette = paletteFor(r.rep.name);
                return (
                  <tr key={`${r.rep.id}-${t.tier}`}>
                    <td style={{ fontWeight: 600, color: palette.color }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <span
                          style={{
                            width: 8, height: 8, borderRadius: 4,
                            background: palette.solid,
                          }}
                        />
                        {r.rep.name}
                      </span>
                    </td>
                    <td>
                      <span className={`badge-tier ${t.tier === "strong" ? "strong" : "normal"}`}>
                        {t.tier === "strong" ? "Strong" : "Normal"}
                      </span>
                    </td>
                    <td>{t.assigned}</td>
                    <td>{t.sent}</td>
                    <td>{t.replied}</td>
                    <td>{t.wechat}</td>
                    <td style={{ color: "var(--green)", fontWeight: 600 }}>{t.convRate}%</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default SalesTab;

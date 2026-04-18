"use client";

import { Analytics } from "./types";

const REP_PALETTES = [
  { bg: "linear-gradient(135deg, #DBEAFE, #BFDBFE)", color: "#1D4ED8", bar: "linear-gradient(90deg, #2563EB, #60A5FA)" },
  { bg: "linear-gradient(135deg, #FCE7F3, #FBCFE8)", color: "#BE185D", bar: "linear-gradient(90deg, #BE185D, #EC4899)" },
  { bg: "linear-gradient(135deg, #FEF3C7, #FDE68A)", color: "#92400E", bar: "linear-gradient(90deg, #B45309, #F59E0B)" },
  { bg: "linear-gradient(135deg, #D1FAE5, #A7F3D0)", color: "#047857", bar: "linear-gradient(90deg, #16A34A, #22C55E)" },
  { bg: "linear-gradient(135deg, #E0E7FF, #C7D2FE)", color: "#4338CA", bar: "linear-gradient(90deg, #4338CA, #818CF8)" },
];

function paletteFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return REP_PALETTES[h % REP_PALETTES.length];
}

function initials(name: string) {
  return name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

export function SalesTab({ analytics }: { analytics: Analytics }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        {analytics.sales.reps.map((r) => {
          const palette = paletteFor(r.rep.name);
          const sendRate = r.assigned > 0 ? Math.round((r.sent / r.assigned) * 100) : 0;
          return (
            <div key={r.rep.id} className="section-card" style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
                <div
                  style={{
                    width: 40, height: 40, borderRadius: 20,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 14, fontWeight: 600,
                    background: palette.bg, color: palette.color,
                  }}
                >
                  {initials(r.rep.name)}
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
            {analytics.sales.reps.flatMap((r) =>
              r.tiers.filter((t) => t.assigned > 0).map((t) => (
                <tr key={`${r.rep.id}-${t.tier}`}>
                  <td style={{ fontWeight: 600 }}>{r.rep.name}</td>
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
              )),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default SalesTab;

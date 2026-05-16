"use client";

/**
 * /admin/conversion-matrix
 *
 * Ground-truth conversion view sourced from MiraclePlus's CRM Open API.
 *
 * Why this exists:
 *   The pipeline has 3 "did this work?" signals — replies, wechat-add,
 *   and MP application-submitted. The third is the highest-fidelity
 *   business signal (someone actually went into the funnel), but lives
 *   in a third-party system. This page joins emails × miracleplus_contacts
 *   × brief_lookups via `getMpConversionMatrix` in canonical-counts.ts.
 *
 * Caveats (surfaced in the callout box):
 *   - MP's API returns email as a partial mask in some cases. We use
 *     local-part canonical match where possible; some legitimate
 *     contacts may not link.
 *   - submittedApplication = MP rows where application_progress is
 *     non-NULL. That includes interview / accepted / etc — not strictly
 *     "submitted only".
 *   - The match is directional: "we emailed this address" ↔ "MP has a
 *     contact with this address". It's the best we can do without
 *     cross-system IDs.
 */

import { useEffect, useState } from "react";
import { Loader2, AlertCircle, Info } from "lucide-react";

interface PerRepRow {
  rep_id: number;
  totalEmailed: number;
  matched: number;
  unregistered: number;
  registered: number;
  submittedApplication: number;
  wechatAdded: number;
  bothWechatAndSubmitted: number;
}

interface Matrix {
  totalEmailed: number;
  matched: number;
  unregistered: number;
  registered: number;
  submittedApplication: number;
  wechatAdded: number;
  bothWechatAndSubmitted: number;
  perRep?: PerRepRow[];
  predicate: { actorRepId?: number; since?: string };
}

interface ApiResponse {
  ok: boolean;
  window_days: number;
  matrix: Matrix;
  rep_names: Record<number, string>;
  error?: string;
}

const WINDOWS = [
  { days: 14, label: "14d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 180, label: "180d" },
];

function pct(numer: number, denom: number): string {
  if (!denom) return "—";
  const p = (numer / denom) * 100;
  if (p < 0.1) return "<0.1%";
  return `${p.toFixed(1)}%`;
}

export default function ConversionMatrixPage() {
  const [windowDays, setWindowDays] = useState(90);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch(`/api/admin/mp-conversion-matrix?since_days=${windowDays}`, {
      credentials: "include",
    })
      .then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as ApiResponse;
        if (!r.ok || !body.ok) {
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        if (!cancelled) setData(body);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e?.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [windowDays]);

  const m = data?.matrix;
  const repNames = data?.rep_names ?? {};

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
        MiraclePlus 转化矩阵 (ground truth)
      </h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        我们外呼过的 email × 在 MP CRM 里出现的 × 真的提交了 application 的 ×
        我们标了 wechat-added 的, 跨 90 天去重 join.
      </p>

      {/* Caveat callout */}
      <div
        className="section-card"
        style={{
          padding: 16,
          marginBottom: 16,
          borderLeft: "3px solid #f59e0b",
          background: "rgba(245, 158, 11, 0.08)",
        }}
      >
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <Info size={18} style={{ flexShrink: 0, marginTop: 2, color: "#f59e0b" }} />
          <div style={{ fontSize: 13, lineHeight: 1.55 }}>
            <strong>directional, 不是 exact</strong>: MP Open API 在部分场景下把
            email 字段 mask 成 <code>******</code>, 我们的 join 走 email 文本
            (lowercased + trimmed) 比对, 所以会有漏匹配. 分桶逻辑:
            <ul style={{ margin: "8px 0 0 0", paddingLeft: 20 }}>
              <li>
                <code>matched</code> = MP 系统里有 contact 记录 (任意状态).
              </li>
              <li>
                <code>unregistered</code> = MP 里有但 application_progress
                ="未注册" (我们邮件触达了 MP 系统, 但人没去注册账号).
              </li>
              <li>
                <code>registered</code> = 注册了但没提交 application.
              </li>
              <li>
                <code>submittedApplication</code> ={" "}
                <strong>真的提交了申请</strong> — 包含 progress 含 "Submitted",
                或 applications_number &gt; 0, 或 submitted_at 非空.
              </li>
            </ul>
            <div style={{ marginTop: 8 }}>
              真正的转化指标是 <code>submittedApplication</code>;{" "}
              <code>matched</code> 只能说"MP 知道这个人".
            </div>
          </div>
        </div>
      </div>

      {/* Window selector */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
        <span style={{ fontSize: 13, opacity: 0.7 }}>窗口:</span>
        {WINDOWS.map((w) => (
          <button
            key={w.days}
            onClick={() => setWindowDays(w.days)}
            className={windowDays === w.days ? "btn btn-primary" : "btn"}
            style={{ padding: "6px 12px", fontSize: 13 }}
          >
            {w.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="section-card" style={{ padding: 24, textAlign: "center" }}>
          <Loader2 size={20} style={{ animation: "spin 1s linear infinite" }} />
          <div style={{ fontSize: 13, opacity: 0.6, marginTop: 8 }}>计算中…</div>
        </div>
      )}

      {err && (
        <div
          className="section-card"
          style={{
            padding: 16,
            background: "rgba(239, 68, 68, 0.08)",
            borderLeft: "3px solid #ef4444",
          }}
        >
          <div style={{ display: "flex", gap: 12 }}>
            <AlertCircle size={18} style={{ flexShrink: 0, color: "#ef4444" }} />
            <div>
              <strong>加载失败:</strong> {err}
            </div>
          </div>
        </div>
      )}

      {!loading && !err && m && (
        <>
          {/* Top-line totals */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(6, 1fr)",
              gap: 12,
              marginBottom: 24,
            }}
          >
            <KpiCard label="发出去 (distinct)" value={m.totalEmailed} />
            <KpiCard
              label="MP 里有 contact"
              value={m.matched}
              sub={`${pct(m.matched, m.totalEmailed)} of emailed`}
            />
            <KpiCard
              label="未注册"
              value={m.unregistered}
              sub={`${pct(m.unregistered, m.totalEmailed)} of emailed`}
            />
            <KpiCard
              label="提交了 application"
              value={m.submittedApplication}
              sub={`${pct(m.submittedApplication, m.totalEmailed)} of emailed`}
              accent="#10b981"
            />
            <KpiCard
              label="加了微信"
              value={m.wechatAdded}
              sub={`${pct(m.wechatAdded, m.totalEmailed)} of emailed`}
            />
            <KpiCard
              label="微信 + 提交"
              value={m.bothWechatAndSubmitted}
              sub={`${pct(m.bothWechatAndSubmitted, m.totalEmailed)} of emailed`}
              accent="#6366f1"
            />
          </div>

          {/* Per-rep breakdown */}
          <div className="section-card" style={{ padding: 0, overflow: "hidden" }}>
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--border, rgba(255,255,255,0.08))",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Per-rep (actor_rep_id from emails table)
            </div>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr style={{ background: "rgba(255,255,255,0.03)" }}>
                  <Th>Rep</Th>
                  <Th align="right">Emailed</Th>
                  <Th align="right">Matched</Th>
                  <Th align="right">未注册</Th>
                  <Th align="right">Registered</Th>
                  <Th align="right">Submitted</Th>
                  <Th align="right">WeChat</Th>
                  <Th align="right">Both</Th>
                  <Th align="right">Conv %</Th>
                </tr>
              </thead>
              <tbody>
                {(m.perRep ?? []).length === 0 && (
                  <tr>
                    <td
                      colSpan={9}
                      style={{ padding: 24, textAlign: "center", opacity: 0.6 }}
                    >
                      没有数据 — 窗口里没人发邮件.
                    </td>
                  </tr>
                )}
                {(m.perRep ?? []).map((r) => (
                  <tr
                    key={r.rep_id}
                    style={{
                      borderTop: "1px solid var(--border, rgba(255,255,255,0.06))",
                    }}
                  >
                    <Td>{repNames[r.rep_id] ?? `rep#${r.rep_id}`}</Td>
                    <Td align="right">{r.totalEmailed}</Td>
                    <Td align="right">{r.matched}</Td>
                    <Td align="right">{r.unregistered}</Td>
                    <Td align="right">{r.registered}</Td>
                    <Td align="right">
                      <strong style={{ color: "#10b981" }}>
                        {r.submittedApplication}
                      </strong>
                    </Td>
                    <Td align="right">{r.wechatAdded}</Td>
                    <Td align="right">{r.bothWechatAndSubmitted}</Td>
                    <Td align="right">
                      {pct(r.submittedApplication, r.totalEmailed)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, fontSize: 12, opacity: 0.5 }}>
            predicate: <code>{JSON.stringify(m.predicate)}</code>
          </div>
        </>
      )}
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="section-card" style={{ padding: 14 }}>
      <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent ?? "inherit" }}>
        {value.toLocaleString()}
      </div>
      {sub && (
        <div style={{ fontSize: 11, opacity: 0.55, marginTop: 4 }}>{sub}</div>
      )}
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      style={{
        textAlign: align ?? "left",
        padding: "10px 16px",
        fontWeight: 600,
        fontSize: 12,
        opacity: 0.7,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      style={{
        textAlign: align ?? "left",
        padding: "10px 16px",
      }}
    >
      {children}
    </td>
  );
}

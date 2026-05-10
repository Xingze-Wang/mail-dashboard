// /analysis/cut/[dim] — generic cut surface in standard app vocabulary.
// Uses page-title / section-card / dx-chip — same look as Pipeline,
// Overview, Emails. The bot summary card uses the standard blue-bg
// callout style.
"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";

interface Segment {
  segment: string;
  delivered: number;
  clicked: number;
  wechat: number;
  ctr: number;
  postClickConv: number;
  endToEnd: number;
  lowN: boolean;
}

interface CutData {
  dim: string;
  label: string;
  slice_label: string;
  scope: { repId: number | null; lookbackDays: number; isAdmin: boolean };
  totals: { delivered: number; clicked: number; wechat: number; overallCtr: number; overallPostClick: number };
  segments: Segment[];
  summary: { summary: string; biggest_lever: string; should_pitch_to_congress: boolean } | null;
  generated_at: string;
  // Realignment banner data — present when today's snapshot was
  // freshly published by the daily cron (vs read-through from a
  // prior day). Populated by /api/cron/insights-realign when its
  // LLM gatekeeper decides today's data has moved enough.
  realignment?: {
    reason: string;
    movement: { segment: string; metric: "ctr" | "post_click_conv" | "sample_size"; from: number; to: number } | null;
    effective_date: string;
    prev_snapshot_id: string | null;
  } | null;
  effective_date?: string;
  source?: "snapshot" | "bootstrap";
}

const SIBLING_CUTS: Array<{ dim: string; label: string }> = [
  { dim: "geo_binary",  label: "Geography" },
  { dim: "direction",   label: "Direction" },
  { dim: "school_tier", label: "School tier" },
  { dim: "lead_tier",   label: "Lead tier" },
  { dim: "h_index",     label: "H-index" },
  { dim: "citations",   label: "Citations" },
];

export default function CutPage({ params }: { params: Promise<{ dim: string }> }) {
  const { dim } = use(params);
  const router = useRouter();
  const [data, setData] = useState<CutData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/analysis/cut?dim=${encodeURIComponent(dim)}`)
      .then(async (r) => {
        if (r.status === 401) { router.replace(`/login?next=/analysis/cut/${dim}`); return null; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { if (!cancelled && d) setData(d); })
      .catch((e) => { if (!cancelled) setErr(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [dim, router]);

  if (loading && !data) {
    return <div style={{ padding: 48, textAlign: "center", color: "var(--text-tertiary)" }}><Loader2 className="h-5 w-5 animate-spin" style={{ display: "inline-block" }} /></div>;
  }
  if (err || !data) {
    return <div style={{ padding: 24, fontSize: 13, color: "var(--text-secondary)" }}>Couldn&apos;t load this cut{err ? `: ${err}` : ""}.</div>;
  }

  // Old behavior: filter out "(no lead data)" and "(unknown)" buckets.
  // Problem: enrichment is sparse — H-index has signal for only ~12% of
  // delivered recipients (148/1335). Hiding the unenriched bucket made
  // the page look like there were 148 total emails; in reality there
  // were 1335, but 1187 didn't have h-index lookup data.
  //
  // New behavior: keep them visible with a (lowN / unenriched) flag so
  // the user sees the FULL population. The bucket is real signal —
  // it's the "we don't have S2/lead enrichment for these recipients"
  // bucket, and that's worth surfacing as a coverage gap.
  const allSegments = data.segments;
  const enrichedSegments = allSegments.filter((s) => s.segment !== "(no lead data)" && s.segment !== "(unknown)");
  const unenrichedSegment = allSegments.find((s) => s.segment === "(no lead data)" || s.segment === "(unknown)");
  const totalDelivered = allSegments.reduce((acc, s) => acc + s.delivered, 0);
  const enrichedDelivered = enrichedSegments.reduce((acc, s) => acc + s.delivered, 0);
  const segments = enrichedSegments;

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <Link href="/analysis" style={{ fontSize: 12, color: "var(--text-tertiary)", textDecoration: "none" }}>
          ← Insights
        </Link>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
            Insights · Cut by {data.slice_label}
          </div>
          <h1 className="page-title">{data.label}</h1>
          <p style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 4 }}>
            Last {data.scope.lookbackDays} days · {data.scope.isAdmin ? "org-wide" : "your sends"}
          </p>
        </div>
      </div>

      {/* Sibling cuts */}
      <CutSiblings active={dim} />

      {/* Realignment banner — visible the day the LLM cron decides
          today's data has moved enough to publish a new snapshot.
          Diff-style: previous A% → today B% on the biggest mover. */}
      {data.realignment && (
        <div
          style={{
            marginTop: 14,
            marginBottom: 18,
            padding: "12px 14px",
            background: "linear-gradient(135deg, rgba(124,58,237,0.07), rgba(37,99,235,0.04))",
            border: "1px solid rgba(124,58,237,0.25)",
            borderRadius: 8,
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
          }}
        >
          <span style={{ fontSize: 16, lineHeight: "20px" }}>✨</span>
          <div style={{ flex: 1, fontSize: 13, color: "var(--text)", lineHeight: 1.55 }}>
            <div style={{ fontSize: 11, color: "#7c3aed", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
              今日重对齐 · {data.realignment.effective_date}
            </div>
            {data.realignment.movement && (
              <div style={{ marginBottom: 4, fontFamily: "monospace", fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary)" }}>{data.realignment.movement.segment}</span>
                <span style={{ color: "var(--text-tertiary)" }}> · {data.realignment.movement.metric}: </span>
                <span style={{ color: "var(--text-tertiary)" }}>{data.realignment.movement.from}%</span>
                <span style={{ color: "var(--text-secondary)" }}> → </span>
                <span style={{ color: "var(--text)", fontWeight: 600 }}>{data.realignment.movement.to}%</span>
              </div>
            )}
            <div>{data.realignment.reason}</div>
          </div>
        </div>
      )}

      {/* Bot summary */}
      {data.summary && (
        <div style={{
          marginTop: 18,
          marginBottom: 24,
          padding: "14px 16px",
          background: "var(--blue-bg)",
          border: "1px solid #BFDBFE",
          borderRadius: 10,
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--blue)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            marginBottom: 6,
          }}>
            {data.summary.biggest_lever}
          </div>
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: "var(--text)" }}>
            {data.summary.summary}
          </p>
          {data.summary.should_pitch_to_congress && (
            <Link href="/congress" style={{
              display: "inline-flex",
              marginTop: 10,
              fontSize: 12,
              color: "var(--blue)",
              textDecoration: "none",
              fontWeight: 500,
            }}>
              Pitch to Congress this week →
            </Link>
          )}
        </div>
      )}

      {/* Coverage banner — explains why some emails don't appear in
          the cut. Shows BOTH numbers (full population vs enriched). */}
      {totalDelivered > 0 && unenrichedSegment && unenrichedSegment.delivered > 0 && (
        <div style={{
          marginTop: 6, marginBottom: 16,
          padding: "10px 14px",
          background: "var(--bg-subtle, #f8fafc)",
          border: "1px dashed var(--border-light, #e5e7eb)",
          borderRadius: 8,
          fontSize: 12, color: "var(--text-secondary)",
          lineHeight: 1.55,
        }}>
          <div>
            Showing <span style={{ fontFamily: "monospace", fontWeight: 600, color: "var(--text)" }}>{enrichedDelivered}</span>
            {" "}of {totalDelivered} delivered emails. The remaining{" "}
            <span style={{ fontFamily: "monospace", fontWeight: 600, color: "var(--coral)" }}>{unenrichedSegment.delivered}</span>
            {" "}have no {data.slice_label} data (recipient never matched our enrichment lookup).
          </div>
          <div style={{ marginTop: 4, opacity: 0.85 }}>
            CTR for those = <span style={{ fontFamily: "monospace" }}>
              {unenrichedSegment.delivered > 0 ? (unenrichedSegment.ctr * 100).toFixed(1) + "%" : "—"}
            </span>
            {" "}({unenrichedSegment.clicked} clicks). They&apos;re bucketed below as &quot;{unenrichedSegment.segment}&quot; for transparency.
          </div>
        </div>
      )}

      {/* Table */}
      {allSegments.length === 0 ? (
        <div className="section-card" style={{ padding: "20px 16px", textAlign: "center", fontSize: 13, color: "var(--text-tertiary)" }}>
          No data for this cut yet.
        </div>
      ) : (
        <Table segments={allSegments} />
      )}

      <div style={{
        marginTop: 24,
        paddingTop: 12,
        borderTop: "1px solid var(--border-light)",
        fontSize: 11.5,
        color: "var(--text-tertiary)",
      }}>
        Updated {new Date(data.generated_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
      </div>
    </div>
  );
}

function CutSiblings({ active }: { active: string }) {
  return (
    <div style={{
      display: "flex",
      flexWrap: "wrap",
      gap: 6,
      marginBottom: 6,
    }}>
      {SIBLING_CUTS.map((c) => {
        const isActive = c.dim === active;
        return (
          <Link
            key={c.dim}
            href={`/analysis/cut/${c.dim}`}
            className={`dx-chip ${isActive ? "active" : ""}`}
            style={{ fontSize: 12, textDecoration: "none" }}
          >
            {c.label}
          </Link>
        );
      })}
    </div>
  );
}

function Table({ segments }: { segments: Segment[] }) {
  const maxCtr = Math.max(...segments.map((s) => s.ctr), 0.01);
  const maxConv = Math.max(...segments.map((s) => s.postClickConv), 0.01);

  return (
    <div className="section-card" style={{ padding: 0, overflow: "hidden" }}>
      <table className="data-table" style={{ marginBottom: 0 }}>
        <thead>
          <tr>
            <th>Segment</th>
            <th>Click rate</th>
            <th>Post-click conv</th>
            <th style={{ textAlign: "right" }}>Sample (delivered/clicked/wechat)</th>
          </tr>
        </thead>
        <tbody>
          {segments.map((s) => <Row key={s.segment} s={s} maxCtr={maxCtr} maxConv={maxConv} />)}
        </tbody>
      </table>
    </div>
  );
}

function Row({ s, maxCtr, maxConv }: { s: Segment; maxCtr: number; maxConv: number }) {
  const fmt = (n: number) => `${(n * 100).toFixed(1)}%`;
  return (
    <tr>
      <td>
        <div style={{ fontWeight: 500 }}>{s.segment}</div>
        {s.lowN && (
          <div style={{ fontSize: 10.5, color: "var(--gold)", marginTop: 2 }}>
            low sample · take with grain of salt
          </div>
        )}
      </td>
      <td><Bar value={s.ctr} max={maxCtr} fmt={fmt} color="var(--coral)" /></td>
      <td><Bar value={s.postClickConv} max={maxConv} fmt={fmt} color="var(--green)" /></td>
      <td style={{
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
        fontSize: 11.5,
        color: "var(--text-tertiary)",
      }}>
        {s.delivered} / {s.clicked} / {s.wechat}
      </td>
    </tr>
  );
}

function Bar({ value, max, fmt, color }: { value: number; max: number; fmt: (n: number) => string; color: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 140 }}>
      <div style={{ flex: 1, height: 6, background: "var(--bg)", borderRadius: 3, overflow: "hidden", minWidth: 60 }}>
        <div style={{
          width: `${pct}%`,
          height: "100%",
          background: color,
          borderRadius: 3,
          transition: "width 0.3s ease",
        }} />
      </div>
      <span style={{
        minWidth: 50,
        textAlign: "right",
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        fontSize: 12.5,
      }}>
        {fmt(value)}
      </span>
    </div>
  );
}

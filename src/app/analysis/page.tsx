// /analysis — bot-curated Insights page.
// Renders /api/insights output: hero stat + sparkline, bot-written intro,
// 2-3 cards picked by the bot. Personalized via memory entries that the
// helper bot wrote when the user said things like "focus on click rate"
// or "stop showing me drift".
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, ArrowUpRight, ArrowDownRight, ArrowRight, MessageSquareMore } from "lucide-react";
import { useLocale, t, type Locale } from "@/lib/i18n";
import type { InsightsPayload, InsightCard, GeoSplit } from "@/app/api/insights/route";
import { MpSignalCounts } from "@/components/MpSignalPills";

export default function InsightsPage() {
  const router = useRouter();
  const locale = useLocale();
  const [data, setData] = useState<InsightsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/insights")
      .then(async (r) => {
        if (r.status === 401) { router.replace("/login?next=/analysis"); return null; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { if (!cancelled && d) setData(d); })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [router]);

  if (loading) {
    return (
      <div style={{ padding: "120px 0", textAlign: "center", color: "var(--text-tertiary)" }}>
        <Loader2 className="h-5 w-5 animate-spin" style={{ display: "inline-block" }} />
        <div style={{ marginTop: 12, fontSize: 13 }}>{t("insights.loading", locale)}</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: "var(--text-secondary)" }}>
        {t("insights.error", locale)}{error ? `: ${error}` : ""}.
      </div>
    );
  }

  return (
    <div>
      {/* ── Page Header ── */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 className="page-title">{t("insights.title", locale)}</h1>
          <span className="lead-count">{data.headline.period}</span>
        </div>
      </div>

      {/* ── Hero stat cards ── */}
      <Hero data={data} locale={locale} />

      {/* ── Bot intro ── */}
      <p style={{ margin: "24px 0 20px", fontSize: 14, lineHeight: 1.6, color: "var(--text-secondary)" }}>
        {data.intro}
      </p>

      {/* ── Insight cards ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {data.cards.length === 0 ? (
          <EmptyCards locale={locale} />
        ) : (
          data.cards.map((c, i) => <CardView key={i} card={c} />)
        )}
      </div>

      {data.geo_split && <GeoSplitCard split={data.geo_split} locale={locale} />}

      <CutLinks locale={locale} />

      <Footer prefs={data.prefs_seen} generatedAt={data.generated_at} locale={locale} />
    </div>
  );
}

function Hero({ data, locale }: { data: InsightsPayload; locale: Locale }) {
  const { headline, mp_signals } = data;
  const delta = headline.delta ?? 0;
  const deltaColor = delta > 0 ? "#16a34a" : delta < 0 ? "#dc2626" : "var(--text-tertiary)";
  const DeltaIcon = delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : ArrowRight;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 8 }}>
      <div className="stat-card">
        <div className="stat-label">{headline.label}</div>
        <div className="stat-value" style={{ color: "var(--blue)" }}>{headline.value}</div>
        {delta !== 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 3, marginTop: 4, fontSize: 12, fontWeight: 600, color: deltaColor }}>
            <DeltaIcon className="h-3 w-3" />
            {delta > 0 ? `+${delta}` : delta}
            <span style={{ fontWeight: 400, color: "var(--text-tertiary)", marginLeft: 2 }}>{t("insights.vsLastWeek", locale)}</span>
          </div>
        )}
        {/* MP signal trio over the funnel lookback (90d) — registered /
            submitted / wechat. User explicitly approved adding this UI on
            /insights surfaces. Falls back gracefully when cached payload
            predates the wire-in. */}
        {mp_signals && (
          <div style={{ marginTop: 10 }}>
            <MpSignalCounts
              registered={mp_signals.registered}
              submittedApplication={mp_signals.submitted}
              addedWechat={mp_signals.addedWechat}
              totalEmailed={mp_signals.totalEmailed}
              size="md"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function CardView({ card }: { card: InsightCard }) {
  const accentColor =
    card.severity === "high"  ? "#dc2626" :
    card.severity === "warn"  ? "#d97706" :
    card.kind === "winner"    ? "#059669" :
    card.kind === "leak"      ? "#dc2626" :
    card.kind === "alert"     ? "#d97706" :
    "#3B82F6";

  return (
    <div className="section-card" style={{ padding: 0 }}>
      <div style={{ padding: "16px 20px", borderLeft: `3px solid ${accentColor}`, borderRadius: "inherit" }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text)", letterSpacing: "-0.01em" }}>
          {card.title}
        </h3>
        <p style={{ margin: "5px 0 0", fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)" }}>
          {card.body}
        </p>

        {card.evidence && card.evidence.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 18 }}>
            {card.evidence.map((e, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span className="stat-label" style={{ marginBottom: 0 }}>{e.label}</span>
                <span style={{ color: "var(--text)", fontWeight: 600, fontSize: 13 }}>{e.value}</span>
              </div>
            ))}
          </div>
        )}

        {card.action && (
          <div style={{ marginTop: 12 }}>
            <Link
              href={card.action.href}
              style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 500, color: accentColor, textDecoration: "none" }}
            >
              {card.action.label}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyCards({ locale }: { locale: Locale }) {
  return (
    <div className="empty-state">
      <p>{t("insights.empty", locale)}</p>
    </div>
  );
}

function GeoSplitCard({ split, locale }: { split: GeoSplit; locale: Locale }) {
  const fmt = (n: number) => `${(n * 100).toFixed(1)}%`;
  const dom = split.domestic;
  const ovs = split.overseas;
  const maxCtr = Math.max(dom.ctr, ovs.ctr, 0.01);
  const maxConv = Math.max(dom.postClickConv, ovs.postClickConv, 0.01);

  const Bar = ({ label, value, max, color, n }: { label: string; value: number; max: number; color: string; n?: number }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
      <span style={{ width: 100, color: "var(--text-secondary)" }}>{label}</span>
      <div style={{ flex: 1, height: 8, background: "var(--bg)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${(value / max) * 100}%`, height: "100%", background: color, borderRadius: 4, transition: "width 0.4s ease" }} />
      </div>
      <span style={{ width: 64, textAlign: "right", fontWeight: 600, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
        {fmt(value)}
      </span>
      {n != null && (
        <span style={{ width: 56, textAlign: "right", fontSize: 11, color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>
          n={n}
        </span>
      )}
    </div>
  );

  return (
    <div className="section-card" style={{ marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>{t("insights.geo", locale)}</h3>
        <Link href="/analysis/geo" style={{ fontSize: 11.5, color: "#3B82F6", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3 }}>
          {t("insights.fullBreak", locale)} <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <p style={{ margin: "0 0 18px", fontSize: 12.5, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
        {t("insights.geoSub", locale)}
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8, marginBottom: 16 }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {t("insights.ctr", locale)}
        </div>
        <Bar label={t("insights.domestic", locale)} value={dom.ctr} max={maxCtr} color="#dc2626" n={dom.delivered} />
        <Bar label={t("insights.overseas", locale)} value={ovs.ctr} max={maxCtr} color="#2563eb" n={ovs.delivered} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8 }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {t("insights.conv", locale)}
        </div>
        <Bar label={t("insights.domestic", locale)} value={dom.postClickConv} max={maxConv} color="#dc2626" n={dom.clicked} />
        <Bar label={t("insights.overseas", locale)} value={ovs.postClickConv} max={maxConv} color="#2563eb" n={ovs.clicked} />
      </div>

      {/* MP signal trio per geo bucket — registered / submitted / wechat.
          Sits between the rate bars and the diagnostic blurb so the reader
          sees both rates AND absolute MP-funnel counts side-by-side. */}
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div style={{ padding: "8px 10px", background: "var(--bg)", borderRadius: 6 }}>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
            {t("insights.domestic", locale)}
          </div>
          <MpSignalCounts
            registered={dom.registered}
            submittedApplication={dom.submitted}
            addedWechat={dom.wechat}
            totalEmailed={dom.delivered}
            size="sm"
          />
        </div>
        <div style={{ padding: "8px 10px", background: "var(--bg)", borderRadius: 6 }}>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
            {t("insights.overseas", locale)}
          </div>
          <MpSignalCounts
            registered={ovs.registered}
            submittedApplication={ovs.submitted}
            addedWechat={ovs.wechat}
            totalEmailed={ovs.delivered}
            size="sm"
          />
        </div>
      </div>

      <div style={{
        marginTop: 16,
        padding: "10px 12px",
        background: "var(--bg)",
        borderRadius: 8,
        fontSize: 12.5,
        lineHeight: 1.55,
        color: "var(--text-secondary)",
      }}>
        {split.ctr_ratio > 1 && split.conv_ratio > 1 ? (
          <>
            Overseas clicks <strong>{split.ctr_ratio}×</strong> more, but domestic converts <strong>{split.conv_ratio}×</strong> more once clicked.
            Different drafts: overseas needs a tighter body + CTA, domestic needs a stronger opener + subject.
          </>
        ) : split.ctr_ratio > 1 ? (
          <>Overseas wins both stages — open rate <strong>{split.ctr_ratio}×</strong> domestic. Look at what differs in tone and apply it across.</>
        ) : split.ctr_ratio < 1 ? (
          <>Domestic wins both stages — click rate <strong>{(1 / Math.max(0.01, split.ctr_ratio)).toFixed(2)}×</strong> overseas. Domestic playbook is working.</>
        ) : (
          <>Volume too low to draw a confident geo conclusion yet.</>
        )}
      </div>
    </div>
  );
}

function CutLinks({ locale }: { locale: Locale }) {
  const cuts = [
    { href: "/analysis/cut/geo_binary",  label: t("insights.geoLink",    locale), caption: t("insights.geoDesc",    locale) },
    { href: "/analysis/cut/direction",   label: t("insights.dirLink",    locale), caption: t("insights.dirDesc",    locale) },
    { href: "/analysis/cut/school_tier", label: t("insights.schoolLink", locale), caption: t("insights.schoolDesc", locale) },
    { href: "/analysis/cut/lead_tier",   label: t("insights.leadLink",   locale), caption: t("insights.leadDesc",   locale) },
    { href: "/analysis/cut/h_index",     label: t("insights.hLink",      locale), caption: t("insights.hDesc",      locale) },
    { href: "/analysis/cut/citations",   label: t("insights.citLink",    locale), caption: t("insights.citDesc",    locale) },
  ];
  return (
    <div className="section-card" style={{ padding: 0, marginTop: 20 }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-light)" }}>
        <h3 style={{ marginBottom: 0 }}>{t("insights.moreCuts", locale)}</h3>
      </div>
      <div>
        {cuts.map((c, i, arr) => (
          <Link key={c.href} href={c.href} style={{
            display: "flex", alignItems: "center", gap: 12,
            textDecoration: "none", color: "var(--text)",
            padding: "13px 20px",
            borderBottom: i === arr.length - 1 ? "none" : "1px solid var(--border-light)",
            transition: "background 0.15s ease",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            <span style={{ fontSize: 13.5, fontWeight: 500 }}>{c.label}</span>
            <span style={{ fontSize: 12, color: "var(--text-tertiary)", flex: 1 }}>{c.caption}</span>
            <ArrowRight className="h-3 w-3" style={{ color: "var(--text-tertiary)" }} />
          </Link>
        ))}
      </div>
    </div>
  );
}

function Footer({ prefs, generatedAt, locale }: { prefs: string[]; generatedAt: string; locale: Locale }) {
  return (
    <div style={{ marginTop: 24, fontSize: 11.5, color: "var(--text-tertiary)", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <MessageSquareMore className="h-3.5 w-3.5" />
        <span>{t("insights.helperHint", locale)}</span>
      </div>
      {prefs.length > 0 && (
        <div style={{ marginLeft: 19, display: "flex", flexWrap: "wrap", gap: 6 }}>
          <span>{t("insights.prefs", locale)}</span>
          {prefs.map((p, i) => (
            <span key={i} style={{
              padding: "2px 8px", borderRadius: 999,
              background: "var(--bg)", border: "1px solid var(--border-light)",
              fontSize: 11, color: "var(--text-secondary)",
            }}>
              {p}
            </span>
          ))}
        </div>
      )}
      <div style={{ marginLeft: 19, fontSize: 10.5 }}>
        {t("insights.updated", locale)} {new Date(generatedAt).toLocaleString()}
      </div>
    </div>
  );
}

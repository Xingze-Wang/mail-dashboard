"use client";

/**
 * Pipeline page — design-D "Refined card stream".
 *
 * Layout (top → bottom):
 *   1. Top bar: breadcrumb + page title + action buttons
 *   2. Stat strip: 5 stat cards with mini-sparklines
 *   3. Page tabs: Leads | Channels | Sales (sub-tab strip)
 *   4. (Leads tab only) Channel filter bar: All / arXiv / HF / GitHub / PH
 *   5. (Leads tab only) Stream toolbar: status chips + rep pills + sort
 *   6. (Leads tab only) Card stream — paper cards (LeadRow) for arXiv,
 *                       discovery cards (DiscoveryCard) for HF/GH/PH.
 *
 * Two-axis filter model:
 *   - PAGE tabs (Leads/Channels/Sales) switch between the lead stream and
 *     the analytics dashboards.
 *   - INSIDE the lead stream, the channel bar acts as a *source filter*
 *     ("All" merges arXiv pipeline_leads with HF/GH/PH discovery_leads;
 *     individual channels show only their slice). The status chip group
 *     filters arXiv leads only.
 *
 * Backend wiring:
 *   - GET /api/pipeline             — arXiv pipeline_leads (existing)
 *   - GET /api/pipeline/analytics   — channel/source counts & sparkline data
 *   - GET /api/discovery            — HF/GH/PH rows from discovery_leads
 *                                     (graceful empty if migration 004 not run)
 *   - POST endpoints unchanged (scan, send, batch-send, /api/pipeline/[id], …)
 *
 * Discovery card actions (find email / promote / mute) are stubs that
 * toast "Coming soon" — the promotion path is not yet wired. View profile
 * does open `profile_url` in a new tab.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  Zap, Send, Loader2, Download, Settings as SettingsIcon, Plus,
  ChevronUp, FileText, Globe, Star,
} from "lucide-react";

/* Inline GitHub mark — lucide-react in this project doesn't ship a Github
   icon, and the mockup uses the official mark inline. */
const GithubMark = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
    <path d="M12 .3a12 12 0 00-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2 0 1.9 1.2 1.9 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 016 0C17.3 4.7 18.3 5 18.3 5c.7 1.6.2 2.8.1 3.2.8.8 1.3 1.9 1.3 3.1 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1.1.9 2.3v3.3c0 .3.2.7.8.6A12 12 0 0012 .3" />
  </svg>
);
import { useToast } from "@/components/ui/toaster";
import { Analytics, DiscoveryLead, Lead, Rep, canSend } from "./types";
import { LeadRow } from "./LeadRow";
import { DiscoveryCard } from "./DiscoveryCard";
import { AddLeadModal } from "./AddLeadModal";
import { ReassignModal } from "./ReassignModal";
import { paletteFor, initialsFor } from "./repColors";
import { isAgeGated, isReadyToSend, isRipeningLead } from "@/lib/policy";
import { ActiveContractCard } from "@/components/ActiveContractCard";
import MissionsBanner from "@/components/missions-banner";
import { useLocale, t } from "@/lib/i18n";

const ChannelsTab = dynamic(() => import("./ChannelsTab").then((m) => m.ChannelsTab), {
  loading: () => <TabLoader />,
});
const SalesTab = dynamic(() => import("./SalesTab").then((m) => m.SalesTab), {
  loading: () => <TabLoader />,
});
const ReviewPane = dynamic(() => import("./ReviewPane").then((m) => m.ReviewPane), {
  loading: () => <TabLoader />,
});
const BulkPane = dynamic(() => import("./BulkPane").then((m) => m.BulkPane), {
  loading: () => <TabLoader />,
});

/* Send-mode toggle (Browse / Review / Bulk). Mode lives in the URL hash so
   the user's choice survives reloads. */
const SEND_MODES = [
  { key: "browse", label: "Browse" },
  { key: "review", label: "Review" },
  { key: "bulk", label: "Bulk" },
] as const;
type SendMode = (typeof SEND_MODES)[number]["key"];

function readModeFromHash(): SendMode {
  if (typeof window === "undefined") return "browse";
  const m = /(?:^|&)mode=(browse|review|bulk)/.exec(window.location.hash.slice(1));
  return (m?.[1] as SendMode) || "browse";
}
function writeModeToHash(mode: SendMode) {
  if (typeof window === "undefined") return;
  const frag = mode === "browse" ? "" : `mode=${mode}`;
  const url = `${window.location.pathname}${window.location.search}${frag ? `#${frag}` : ""}`;
  window.history.replaceState(null, "", url);
}

/* ── CSV export helpers (preserved) ──────────────────────────────────── */

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function leadsToCsv(leads: Lead[], reps: Rep[]): string {
  const repName = (id: number | null) =>
    id == null ? "" : reps.find((r) => r.id === id)?.name ?? `#${id}`;
  const rows = [
    ["title", "author", "email", "school", "hIndex", "citations", "tier", "status", "sentAt", "repName"],
    ...leads.map((l) => [
      l.title,
      l.authorName ?? "",
      l.authorEmail,
      l.schoolName ?? "",
      l.hIndex ?? "",
      l.citationCount ?? "",
      l.leadTier ?? "",
      l.status,
      l.sentAt ? new Date(l.sentAt).toISOString() : "",
      repName(l.assignedRepId),
    ]),
  ];
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

function downloadCsv(filename: string, body: string) {
  const blob = new Blob(["\uFEFF" + body], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function shortDateForFilename(): string {
  const d = new Date();
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  return `${months[d.getMonth()]}-${d.getDate()}-${d.getFullYear()}`;
}

function TabLoader() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 88 }} />
      ))}
    </div>
  );
}

/* ── Stat strip ──────────────────────────────────────────────────────── */

interface StatDef {
  label: string;
  value: string;
  unit?: string;
  trend?: { kind: "up" | "down" | "flat"; text: string };
  spark: { color: string; points: string };
}

function Sparkline({ color, points }: { color: string; points: string }) {
  const fill = color.replace("rgb", "rgba").replace(")", ",0.08)");
  // For hex colors, fall back to a generic light fill via opacity attribute.
  const isHex = color.startsWith("#");
  return (
    <svg className="dx-sparkline" viewBox="0 0 200 32" preserveAspectRatio="none">
      <polyline fill="none" stroke={color} strokeWidth="1.6" points={points} />
      {isHex ? (
        <polyline fill={color} fillOpacity={0.08} stroke="none" points={`${points} 200,32 0,32`} />
      ) : (
        <polyline fill={fill} stroke="none" points={`${points} 200,32 0,32`} />
      )}
    </svg>
  );
}

function StatCard({ stat }: { stat: StatDef }) {
  return (
    <div className="dx-stat">
      <div className="dx-stat-head">
        <span className="dx-stat-label">{stat.label}</span>
        {stat.trend && (
          <span className={`dx-stat-trend ${stat.trend.kind === "flat" ? "flat" : stat.trend.kind === "down" ? "down" : ""}`}>
            {stat.trend.kind === "up" && (
              <ChevronUp style={{ width: 9, height: 9, strokeWidth: 3 }} />
            )}
            {stat.trend.text}
          </span>
        )}
      </div>
      <div className="dx-stat-value">
        {stat.value}
        {stat.unit && <span className="dx-unit">{stat.unit}</span>}
      </div>
      <Sparkline color={stat.spark.color} points={stat.spark.points} />
    </div>
  );
}

/* Build sparkline points from a daily-counts array (last 30d → 12 samples). */
function dailyToSparkline(daily: Array<{ date: string; strong: number; normal: number }> | undefined): string {
  if (!daily || daily.length === 0) {
    return "0,16 50,16 100,16 150,16 200,16";
  }
  const values = daily.map((d) => d.strong + d.normal);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = 200 / Math.max(1, values.length - 1);
  return values
    .map((v, i) => {
      const x = Math.round(i * step);
      const y = Math.round(28 - ((v - min) / range) * 24); // invert + leave headroom
      return `${x},${y}`;
    })
    .join(" ");
}

/* ── Channel + Status filter constants ────────────────────────────────── */

const CHANNELS = [
  { key: "all",    label: "All",           color: undefined },
  { key: "arxiv",  label: "arXiv",         color: "var(--dx-src-arxiv)" },
  { key: "hf",     label: "Hugging Face",  color: "var(--dx-src-hf)" },
  { key: "github", label: "GitHub",        color: "var(--dx-src-gh)" },
  { key: "ph",     label: "Product Hunt",  color: "var(--dx-src-ph)" },
] as const;
type ChannelKey = (typeof CHANNELS)[number]["key"];

const STATUS_CHIPS = [
  { key: "all",                label: "All status" },
  { key: "drafting",           label: "Drafting" },
  { key: "ripening",           label: "Ripening" },
  { key: "ready",              label: "Ready" },
  { key: "sent",               label: "Sent" },
  { key: "replied",            label: "Replied" },
  { key: "skipped",            label: "Skipped" },
  { key: "qc_quarantined",     label: "QC 隔离" },
  { key: "judge_quarantined",  label: "Judge 隔离" },
] as const;
type StatusKey = (typeof STATUS_CHIPS)[number]["key"];

// "Ripening" = status='ready' AND past the 7-day cooldown gate.
// Anchored on `created_at` (when the lead entered our pipeline), which
// is the same anchor the server-side `/api/pipeline/ready-count` and
// `contact-guard.ts` use. The previous version of this file anchored on
// `published_at` instead, producing a three-way mismatch between the
// page header, the sidebar badge, and the batch-send banner — see the
// 2026-05-09 smoke. Use the canonical helpers from src/lib/policy.ts;
// the wrapper here just adapts the `Lead` shape (camelCase fields) to
// the helper's snake_case-agnostic input.
function isRipening(lead: { status: string; createdAt: string }): boolean {
  return isRipeningLead({ status: lead.status, createdAt: lead.createdAt });
}

const SORT_OPTIONS = [
  { key: "newest",   label: "Sort: Newest" },
  { key: "score",    label: "Sort: Score" },
  { key: "tier",     label: "Sort: Tier" },
  { key: "activity", label: "Sort: Last activity" },
] as const;
type SortKey = (typeof SORT_OPTIONS)[number]["key"];

/* Channel icons (inline SVGs from the mockup so they look identical). */
function ChannelIcon({ ch }: { ch: ChannelKey }) {
  switch (ch) {
    case "all":
      return (
        <span className="dx-ch-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/></svg>
        </span>
      );
    case "arxiv":
      return (
        <span className="dx-ch-icon" style={{ color: "var(--dx-src-arxiv)" }}>
          <FileText />
        </span>
      );
    case "hf":
      return (
        <span className="dx-ch-icon" style={{ color: "var(--dx-src-hf)" }}>
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="9"/></svg>
        </span>
      );
    case "github":
      return (
        <span className="dx-ch-icon" style={{ color: "var(--dx-src-gh)" }}>
          <GithubMark />
        </span>
      );
    case "ph":
      return (
        <span className="dx-ch-icon" style={{ color: "var(--dx-src-ph)" }}>
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.6 0 12 0zm.7 13.5h-3v3.5H7V6.9h5.7c2.6 0 4.5 1.5 4.5 3.3 0 1.8-1.9 3.3-4.5 3.3z"/></svg>
        </span>
      );
  }
}

/* ── Page component ───────────────────────────────────────────────────── */

export default function PipelinePage() {
  const { toast } = useToast();
  const router = useRouter();
  const locale = useLocale();

  const SEND_MODES_L = [
    { key: "browse" as const, label: t("pipeline.browse", locale) },
    { key: "review" as const, label: t("pipeline.review", locale) },
    { key: "bulk"   as const, label: t("pipeline.bulk",   locale) },
  ];

  const CHANNELS_L = [
    { key: "all"    as const, label: t("pipeline.all",        locale), color: undefined },
    { key: "arxiv"  as const, label: "arXiv",                          color: "var(--dx-src-arxiv)" },
    { key: "hf"     as const, label: "Hugging Face",                   color: "var(--dx-src-hf)" },
    { key: "github" as const, label: "GitHub",                         color: "var(--dx-src-gh)" },
    { key: "ph"     as const, label: "Product Hunt",                   color: "var(--dx-src-ph)" },
  ];

  const STATUS_CHIPS_L = [
    { key: "all"               as const, label: t("pipeline.allStatus", locale) },
    { key: "drafting"          as const, label: t("pipeline.drafting",  locale) },
    { key: "ripening"          as const, label: t("pipeline.ripening",  locale) },
    { key: "ready"             as const, label: t("pipeline.ready",     locale) },
    { key: "sent"              as const, label: t("stat.sent",          locale) },
    { key: "replied"           as const, label: t("pipeline.replied",   locale) },
    { key: "skipped"           as const, label: t("pipeline.skipped",   locale) },
    // QC quarantine buckets (mig 103/104). Admin-facing — surface them
    // so reviewers can find drafts the gate held back.
    { key: "qc_quarantined"    as const, label: "QC 隔离" },
    { key: "judge_quarantined" as const, label: "Judge 隔离" },
  ];

  const SORT_OPTIONS_L = [
    { key: "newest"   as const, label: t("pipeline.sortNewest",   locale) },
    { key: "score"    as const, label: t("pipeline.sortScore",    locale) },
    { key: "tier"     as const, label: t("pipeline.sortTier",     locale) },
    { key: "activity" as const, label: t("pipeline.sortActivity", locale) },
  ];

  const [addLeadOpen, setAddLeadOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [myRepId, setMyRepId] = useState<number | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);

  const [leads, setLeads] = useState<Lead[]>([]);
  // True DB-side total of arXiv leads matching the current scope (server
  // returns this from canonical-counts). `leads.length` only reflects the
  // current page, which used to cap at the paginated limit and produce
  // "1,000 active leads" while the DB had 3,068. Always read this state
  // for any "total leads" number on this page.
  const [arxivTotalAll, setArxivTotalAll] = useState<number>(0);
  // Ready / sendable / ripening also come from canonical-counts via
  // /api/pipeline/ready-count — NOT from leads.filter(status='ready').
  // The leads array is the most-recent-1000 slice; admin views where
  // none of the recent-1000 are status='ready' would show 0 sendable
  // even though the DB has thousands. Now the stat strip reads the
  // same primitive as the sidebar badge.
  const [readyCounts, setReadyCounts] = useState<{ count: number; readyNow: number; ripening: number }>({ count: 0, readyNow: 0, ripening: 0 });
  // Per-status breakdown for the filter chips. Comes from
  // /api/pipeline/status-counts (canonical-counts.countLeadsByStatus).
  // NEVER compute chip counts from leads.filter(...).length — that
  // array is the paginated render slice.
  const [statusCounts, setStatusCounts] = useState<{ total: number; byStatus: Record<string, number>; ready: { total: number; sendable: number; ripening: number } } | null>(null);
  const [discoveryLeads, setDiscoveryLeads] = useState<DiscoveryLead[]>([]);
  const [discoveryBySource, setDiscoveryBySource] = useState<{ hf: number; ph: number; github: number }>({ hf: 0, ph: 0, github: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [channelFilter, setChannelFilter] = useState<ChannelKey>("all");
  const [statusFilter, setStatusFilter] = useState<StatusKey>("all");
  const [repFilter, setRepFilter] = useState<number | "all">("all");
  const [sort, setSort] = useState<SortKey>("newest");
  const [scanning, setScanning] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [batchSending, setBatchSending] = useState(false);
  const [activeTab, setActiveTab] = useState<"leads" | "channels" | "sales">("leads");
  const [sendMode, setSendMode] = useState<SendMode>("browse");
  const [reps, setReps] = useState<Rep[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  // Sticky copy of the last successful analytics fetch — prevents the
  // stat strip from flashing back to 0 ("no new leads") while a refetch
  // is in flight. setAnalytics(null) is used as a refresh signal, which
  // would otherwise make value=0 and trend="no new leads" simultaneously
  // appear next to a still-valid "Total leads 3,162" card. The stat
  // strip reads from `effectiveAnalytics` below, which is `analytics` or
  // the last-known-good copy.
  const [stickyAnalytics, setStickyAnalytics] = useState<Analytics | null>(null);

  const hasInitialised = useRef(false);

  // Load who-am-I once; sales default to seeing only their own leads.
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.authenticated) {
          const admin = d.role === "admin";
          setIsAdmin(admin);
          setMyRepId(typeof d.repId === "number" ? d.repId : null);
          if (!admin && typeof d.repId === "number") {
            setRepFilter(d.repId);
          }
        }
        setMeLoaded(true);
      })
      .catch(() => setMeLoaded(true));
  }, []);

  // Hydrate mode from URL hash on mount, then persist on every change.
  useEffect(() => {
    setSendMode(readModeFromHash());
  }, []);
  useEffect(() => {
    writeModeToHash(sendMode);
  }, [sendMode]);

  // Listen for hash changes — clicking "Review" on a row deep-links via hash.
  useEffect(() => {
    const onHash = () => setSendMode(readModeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /* ── Fetchers ────────────────────────────────────────────────────── */

  const fetchLeads = useCallback(
    (signal?: AbortSignal, statusForUrl?: StatusKey) => {
      if (!hasInitialised.current) setLoading(true);
      else setRefreshing(true);
      // The `leads` array is intentionally the most recent 1000 rows for
      // rendering — older leads aren't worth scrolling through. The
      // grand-total count comes separately from `data.total` (sourced
      // from canonical-counts.countLeads on the server) so any "total"
      // displayed on this page matches the DB, not the paginated array.
      // Ready-count is fetched in parallel from the same primitive that
      // powers the sidebar badge — see the readyCounts state comment.
      //
      // Pass server-side status filter: the chip counts (canonical) and
      // the listed rows previously disagreed when ready leads were older
      // than the 1000-row newest-first window — clicking "Ready 1176"
      // showed "No leads yet" because the visible 1000 rows were all
      // drafting/new and the client-side `.status === "ready"` filter
      // matched zero of them. Filtering server-side moves the right
      // rows into the window before pagination.
      const statusParam = (() => {
        if (!statusForUrl || statusForUrl === "all") return "";
        // UI's "drafting" / "ripening" chips bucket multiple DB statuses,
        // so we can't push them server-side — they still client-filter
        // on the wider fetch. For the rest, server-side is cleaner.
        if (statusForUrl === "drafting" || statusForUrl === "ripening") return "";
        return `&status=${statusForUrl}`;
      })();
      return Promise.all([
        fetch(`/api/pipeline?limit=1000${statusParam}`, { signal }).then((r) => r.json()),
        fetch(`/api/pipeline/ready-count`, { signal, cache: "no-store" }).then((r) => r.json()),
        fetch(`/api/pipeline/status-counts`, { signal, cache: "no-store" }).then((r) => r.json()),
      ])
        .then(([data, rc, sc]) => {
          setLeads(data.leads || []);
          setArxivTotalAll(typeof data.total === "number" ? data.total : (data.leads?.length ?? 0));
          setReadyCounts({
            count: typeof rc?.count === "number" ? rc.count : 0,
            readyNow: typeof rc?.readyNow === "number" ? rc.readyNow : 0,
            ripening: typeof rc?.ripening === "number" ? rc.ripening : 0,
          });
          if (sc && typeof sc.total === "number") {
            setStatusCounts({
              total: sc.total,
              byStatus: sc.byStatus ?? {},
              ready: sc.ready ?? { total: 0, sendable: 0, ripening: 0 },
            });
          }
        })
        .catch((err) => { if (err.name !== "AbortError") console.error(err); })
        .finally(() => {
          hasInitialised.current = true;
          setLoading(false);
          setRefreshing(false);
        });
    },
    [],
  );

  const fetchDiscovery = useCallback((signal?: AbortSignal) => {
    return fetch(`/api/discovery?source=hf,github,ph&limit=100`, { signal })
      .then((r) => r.json())
      .then((data) => {
        setDiscoveryLeads(data.leads || []);
        setDiscoveryBySource(data.bySource || { hf: 0, ph: 0, github: 0 });
      })
      .catch((err) => { if (err.name !== "AbortError") console.error(err); });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchLeads(ctrl.signal, statusFilter);
    fetchDiscovery(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchLeads, fetchDiscovery, statusFilter]);

  // Browser-side draft-queue polling REMOVED. Reason: 4 sales × multiple
  // tabs × every 15s = thousands of req/day to Vercel for the rare case
  // where a lead lacks a draft. Now that Python ships drafts pre-filled
  // (with placeholders for rep identity), 99% of leads land 'ready'
  // immediately. The remaining cases — manual /pipeline "Add lead" form
  // and discovery-promote — are rare and either already 'ready' or get
  // drafted on the next /api/cron tick (daily). If you really need it
  // sooner, hit /api/pipeline/draft-queue manually as admin.

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/sales-reps", { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => setReps(d.reps || []))
      .catch((err) => { if (err.name !== "AbortError") console.error(err); });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    setAnalyticsLoading(true);
    // cache: "no-store" defeats Next.js data cache so "This week" and
    // other time-windowed counters reflect the live DB, not yesterday.
    fetch("/api/pipeline/analytics", { signal: ctrl.signal, cache: "no-store" })
      .then((r) => r.json())
      .then((a: Analytics) => {
        setAnalytics(a);
        // Sticky update only when the new value has the fields we care
        // about — guards against intermediate empty responses (which
        // happen during deploys / cron-induced latency spikes) flipping
        // the stat strip back to 0.
        if (a && typeof a.channels?.leadsThisWeek === "number") {
          setStickyAnalytics(a);
        }
      })
      .catch((err) => { if (err.name !== "AbortError") console.error(err); })
      .finally(() => setAnalyticsLoading(false));
    return () => ctrl.abort();
    // Re-pull whenever the leads array changes length — a new import or
    // a send should update the stat strip immediately, not next reload.
  }, [leads.length]);

  const refreshAnalytics = useCallback(() => setAnalytics(null), []);

  /* ── Channel counts ──────────────────────────────────────────────── */

  const channelCounts = useMemo(() => {
    // arxivTotal is the DB-side total returned by /api/pipeline (which
    // delegates to canonical-counts.countLeads). NOT `leads.length` —
    // that's just the current paginated render slice and silently caps
    // at the API's limit. The /pipeline page subtitle and the "Total
    // leads" analytics card now read from the same primitive.
    const arxivTotal = arxivTotalAll;
    const hf = discoveryBySource.hf ?? 0;
    const gh = discoveryBySource.github ?? 0;
    const ph = discoveryBySource.ph ?? 0;
    return {
      all: arxivTotal + hf + gh + ph,
      arxiv: arxivTotal,
      hf,
      github: gh,
      ph,
    };
  }, [arxivTotalAll, discoveryBySource]);

  /* ── Filtered + sorted streams ───────────────────────────────────── */

  const filteredArxivLeads = useMemo(() => {
    let result = leads;
    if (statusFilter !== "all") {
      result = result.filter((l) => {
        // "Drafting" covers queued (still waiting) + drafting (in flight) +
        // legacy "new" (pre-queue flow, same user intent).
        if (statusFilter === "drafting")
          return l.status === "queued" || l.status === "drafting" || l.status === "new";
        // "Ripening" is status=ready BUT paper is < 7 days old — server-side
        // contact-guard will still block send unless override.
        if (statusFilter === "ripening") return isRipening(l);
        // "Ready" excludes ripening so the label matches the send behavior.
        if (statusFilter === "ready") return l.status === "ready" && !isRipening(l);
        if (statusFilter === "sent") return l.status === "sent";
        if (statusFilter === "replied") return l.status === "replied";
        if (statusFilter === "skipped") return l.status === "skipped";
        return true;
      });
    }
    if (repFilter !== "all") {
      result = result.filter((l) => l.assignedRepId === repFilter);
    }
    return result;
  }, [leads, statusFilter, repFilter]);

  const filteredDiscovery = useMemo(() => {
    let result = discoveryLeads;
    if (channelFilter === "hf") result = result.filter((d) => d.source === "hf");
    else if (channelFilter === "github") result = result.filter((d) => d.source === "github");
    else if (channelFilter === "ph") result = result.filter((d) => d.source === "ph");
    else if (channelFilter === "arxiv") result = [];
    return result;
  }, [discoveryLeads, channelFilter]);

  const showArxiv = channelFilter === "all" || channelFilter === "arxiv";

  const sortedArxiv = useMemo(() => {
    if (!showArxiv) return [];
    const arr = [...filteredArxivLeads];
    arr.sort((a, b) => {
      switch (sort) {
        case "score": {
          // Prefer the trained local scorer; fall back to citation count.
          const sa = a.localScore ?? (a.citationCount ?? 0) / 10000;
          const sb = b.localScore ?? (b.citationCount ?? 0) / 10000;
          return sb - sa;
        }
        case "tier":
          if ((a.leadTier === "strong") === (b.leadTier === "strong")) return 0;
          return a.leadTier === "strong" ? -1 : 1;
        case "activity":
          return new Date(b.sentAt ?? b.createdAt).getTime() - new Date(a.sentAt ?? a.createdAt).getTime();
        case "newest":
        default:
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
    });
    return arr;
  }, [filteredArxivLeads, sort, showArxiv]);

  const sortedDiscovery = useMemo(() => {
    const arr = [...filteredDiscovery];
    arr.sort((a, b) => {
      switch (sort) {
        case "score":
          return b.score - a.score;
        case "tier":
          return b.score - a.score; // discovery has no tier; fall back to score
        case "activity":
          return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
        case "newest":
        default:
          return new Date(b.firstSeen).getTime() - new Date(a.firstSeen).getTime();
      }
    });
    return arr;
  }, [filteredDiscovery, sort]);

  /* ── Batch actions ───────────────────────────────────────────────── */

  // Browse-mode batch banner: excludes age-gated leads. Operators who want
  // to send under-7d leads should use Bulk mode (per-lead override) or the
  // per-row override button on the card itself.
  const batchLeads = useMemo(
    () =>
      sortedArxiv.filter(
        (l) => canSend(l).ok && !excluded.has(l.id) && !isAgeGated(l.createdAt),
      ),
    [sortedArxiv, excluded],
  );
  const batchStrong = batchLeads.filter((l) => l.leadTier === "strong").length;
  const batchNormal = batchLeads.length - batchStrong;

  const handleToggleExpand = useCallback(
    (id: string) => setExpanded((cur) => (cur === id ? null : id)),
    [],
  );

  const handleToggleExclude = useCallback((id: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleRepChange = useCallback(async (leadId: string, repId: number) => {
    await fetch(`/api/pipeline/${leadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedRepId: repId }),
    });
    fetchLeads();
  }, [fetchLeads]);

  const handleScan = async () => {
    setScanning(true);
    try {
      const res = await fetch("/api/pipeline/scan", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        toast({
          variant: "success",
          title: `Found ${data.leadsCreated} new leads`,
          description: `Scanned ${data.stats?.checked || 0} papers`,
        });
        fetchLeads();
        refreshAnalytics();
      } else {
        toast({ variant: "error", title: "Scan failed", description: data.error });
      }
    } catch {
      toast({ variant: "error", title: "Scan failed", description: "Network error" });
    } finally {
      setScanning(false);
    }
  };

  const handleSend = useCallback(async (lead: Lead, override?: boolean) => {
    // Confirm-before-send. Sales reported the previous behavior fired
    // immediately on click, with no preview of WHO the mail goes to or
    // WHAT subject it has — and a misclick on a hot row sent a real
    // email. A native confirm() keeps it lightweight and unblocked
    // by the design system; the body is short so it fits the dialog.
    const subject = lead.draftSubject ?? "(no subject yet)";
    const recipient = lead.authorEmail ?? "(no recipient)";
    const overrideHint = override ? "\n\n⚠ Override: paper is <7 days old." : "";
    const ok = typeof window !== "undefined"
      ? window.confirm(`Send to ${recipient}?\nSubject: ${subject}${overrideHint}`)
      : true;
    if (!ok) return;

    setSending(lead.id);
    try {
      const res = await fetch("/api/pipeline/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id, override: override === true }),
      });
      let data: Record<string, unknown> = {};
      try { data = await res.json(); } catch { /* non-JSON body */ }
      if (!res.ok) {
        // Surface the API's specific error string. Falls through to a
        // status-code hint when the body has no .error field, instead
        // of the previous undefined-as-description that rendered as a
        // bare red banner with no info.
        const apiError = typeof data.error === "string" ? data.error : null;
        const description = apiError ?? `Send failed (HTTP ${res.status}). Try again or check the lead status.`;
        toast({ variant: "error", title: "Send failed", description });
      } else {
        toast({ variant: "success", title: "Email sent", description: lead.authorEmail });
        fetchLeads();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Network error";
      toast({ variant: "error", title: "Send failed", description: msg });
    } finally {
      setSending(null);
    }
  }, [fetchLeads, toast]);

  const handleBatchSend = async () => {
    if (batchLeads.length === 0) return;
    setBatchSending(true);
    try {
      const res = await fetch("/api/pipeline/batch-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: batchLeads.map((l) => l.id) }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({
          variant: "success",
          title: `Sent ${data.sent}`,
          description: data.skipped ? `${data.skipped} skipped` : undefined,
        });
        setExcluded(new Set());
        fetchLeads();
      } else {
        toast({ variant: "error", title: "Batch send failed", description: data.error });
      }
    } catch {
      toast({ variant: "error", title: "Batch send failed", description: "Network error" });
    } finally {
      setBatchSending(false);
    }
  };

  // Browse-mode skip deliberately sets a terminal status='skipped' —
  // different from ReviewPane's skip, which only advances the cursor
  // without flipping status. The Browse click is an explicit "don't
  // send this one", reflected in the Skipped chip on the status
  // sidebar; ReviewPane's is "move to next lead, I'll decide later."
  // Don't unify these — they're different user intents.
  const handleSkip = useCallback(async (id: string) => {
    await fetch(`/api/pipeline/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "skipped" }),
    });
    fetchLeads();
  }, [fetchLeads]);

  const handleSaveEdit = useCallback(async (id: string, draftSubject: string, draftHtml: string) => {
    // Surface the actual outcome — the old version showed "Draft saved"
    // on every click regardless of server response, which silently lost
    // edits when the PATCH failed.
    try {
      const res = await fetch(`/api/pipeline/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftSubject, draftHtml }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast({ variant: "error", title: "Draft save failed", description: data.error ?? `HTTP ${res.status}` });
        return;
      }
      toast({ variant: "success", title: "Draft saved" });
      fetchLeads();
    } catch (e) {
      toast({ variant: "error", title: "Draft save failed", description: e instanceof Error ? e.message : "Network error" });
    }
  }, [fetchLeads, toast]);

  const handleReassignAll = async () => {
    try {
      const res = await fetch("/api/config/assignment", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        toast({ variant: "success", title: `Re-assigned ${data.reassigned} leads` });
        fetchLeads();
      } else {
        toast({ variant: "error", title: "Re-assign failed", description: data.error });
      }
    } catch {
      toast({ variant: "error", title: "Re-assign failed", description: "Network error" });
    }
  };

  const handleExport = useCallback(() => {
    const exportable = sortedArxiv;
    if (exportable.length === 0) {
      toast({ variant: "info", title: "Nothing to export", description: "No leads match the current filters." });
      return;
    }
    downloadCsv(`pipeline-${shortDateForFilename()}.csv`, leadsToCsv(exportable, reps));
    toast({
      variant: "success",
      title: `Exported ${exportable.length} leads`,
      description: `pipeline-${shortDateForFilename()}.csv`,
    });
  }, [sortedArxiv, reps, toast]);

  const handleOpenSettings = useCallback(() => {
    router.push("/settings#assignment");
  }, [router]);

  const handleLeadCreated = useCallback(() => {
    toast({ variant: "success", title: "Lead added" });
    fetchLeads();
    refreshAnalytics();
  }, [fetchLeads, refreshAnalytics, toast]);

  const handleDiscoveryAction = useCallback(
    (action: "find" | "mute" | "view", lead: DiscoveryLead) => {
      const labels: Record<typeof action, string> = {
        find: "Find email",
        mute: "Mute",
        view: "View profile",
      };
      toast({
        variant: "info",
        title: `${labels[action]} — coming soon`,
        description: `${lead.fullname || lead.externalId} (${lead.source})`,
      });
    },
    [toast],
  );

  const handleDiscoveryPromoted = useCallback(() => {
    // Discovery row got stamped promoted_at + a new pipeline_leads row was
    // created. Refresh both streams so the card disappears from the
    // discovery side and shows up under arXiv-shaped leads.
    fetchDiscovery();
    fetchLeads();
    refreshAnalytics();
  }, [fetchDiscovery, fetchLeads, refreshAnalytics]);

  // Listen for window-wide refresh requests (DiscoveryCard dispatches this
  // after a successful promote so any other mounted view can react too).
  useEffect(() => {
    const handler = () => {
      fetchDiscovery();
      fetchLeads();
    };
    window.addEventListener("pipeline:refresh", handler);
    return () => window.removeEventListener("pipeline:refresh", handler);
  }, [fetchDiscovery, fetchLeads]);

  /* ── Stat strip data ────────────────────────────────────────────── */

  const statDefs: StatDef[] = useMemo(() => {
    // Use stickyAnalytics so a transient refetch (analytics=null) doesn't
    // flash the strip back to 0. stickyAnalytics is the last response
    // that had real numbers; falls back to current analytics if no good
    // response yet.
    const eff = stickyAnalytics ?? analytics;
    const ch = eff?.channels;
    const totalLeads = (ch?.totalLeads ?? arxivTotalAll) + (discoveryBySource.hf + discoveryBySource.github + discoveryBySource.ph);
    const thisWeek = ch?.leadsThisWeek ?? 0;
    const sent = ch?.sentLeads ?? 0;
    // Two distinct counts: ready+sendable (passed cooldown) vs total ready
    // (includes papers <7d old that aren't yet eligible to send). Both
    // come from /api/pipeline/ready-count (canonical-counts) — NOT from
    // leads.filter(), because the leads array is a paginated render
    // slice that can miss the rows we're counting.
    const readyAll = readyCounts.count;
    const ripening = readyCounts.ripening;
    const ready = readyCounts.readyNow;
    const conv = ch?.conversionRate ?? 0;
    const sparkPoints = dailyToSparkline(ch?.daily);
    return [
      {
        label: "Total leads",
        value: totalLeads.toLocaleString(),
        trend: thisWeek > 0 ? { kind: "up", text: `+${thisWeek}` } : { kind: "flat", text: "±0" },
        spark: { color: "#15803D", points: sparkPoints },
      },
      {
        label: "This week",
        value: String(thisWeek),
        trend: thisWeek > 0
          ? { kind: "up" as const, text: `+${thisWeek} new` }
          : { kind: "flat" as const, text: "no new leads" },
        spark: { color: "#1D4ED8", points: sparkPoints },
      },
      {
        label: "Ready to send",
        value: String(ready),
        // /readyAll surfaces the cooldown wait — "12/200" means 12 sendable,
        // 188 in cooldown waiting for the 7d age gate. Far more useful than
        // /leads.length which just told you "Ready out of total pipeline".
        unit: readyAll > ready ? `/${readyAll}` : undefined,
        trend: ready > 0
          ? { kind: "up", text: `+${ready} sendable` }
          : ripening > 0
          ? { kind: "flat", text: `${ripening} cooling down` }
          : { kind: "flat", text: "±0" },
        spark: { color: "#B45309", points: sparkPoints },
      },
      {
        // Label fix: `sent` from analytics is all-time pipeline_leads in
        // sent/replied status, not 7-day. Renamed honestly. Audit-flagged.
        label: "Sent (all-time)",
        value: String(sent),
        trend: { kind: "flat", text: "±0" },
        spark: { color: "#5A5A56", points: sparkPoints },
      },
      {
        // Label fix: `conv` is wechat_conversion_rate (wechat_count /
        // unique_delivered), NOT reply rate. Renamed honestly. Audit-flagged.
        label: "WeChat rate",
        value: conv.toFixed(1),
        unit: "%",
        trend: conv > 0 ? { kind: "up", text: `${conv.toFixed(1)}%` } : { kind: "flat", text: "0%" },
        spark: { color: "#6D28D9", points: sparkPoints },
      },
    ];
  }, [analytics, stickyAnalytics, arxivTotalAll, leads, discoveryBySource, readyCounts]);

  /* ── Render ──────────────────────────────────────────────────────── */

  const allEmpty = sortedArxiv.length === 0 && sortedDiscovery.length === 0;
  const showPHOnboarding = channelFilter === "ph" && sortedDiscovery.length === 0 && !loading;

  return (
    <div>
      {/* ── Top bar ── */}
      <div className="dx-topbar">
        <div>
          <div className="dx-crumb">
            <span>Workspace</span>
            <span className="dx-sep">/</span>
            <span>Pipeline</span>
          </div>
          <div className="dx-page-title">
            {t("pipeline.title", locale)}
            <span className="dx-subtle">
              {channelCounts.all.toLocaleString()} active leads
              {refreshing && (
                <Loader2 className="animate-spin" style={{ display: "inline", width: 12, height: 12, marginLeft: 8, color: "var(--dx-text-3)" }} />
              )}
            </span>
          </div>
        </div>
        <div className="dx-topbar-actions">
          {isAdmin && (
            <button onClick={() => setReassignOpen(true)} className="dx-secondary">
              {t("pipeline.reassign", locale)}
            </button>
          )}
          <button onClick={handleScan} disabled={scanning} className="dx-secondary">
            {scanning ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : <Zap />}
            {scanning ? "Scanning…" : t("pipeline.scanArxiv", locale)}
          </button>
          <button className="dx-secondary" type="button" onClick={handleExport}>
            <Download />
            {t("pipeline.export", locale)}
          </button>
          {isAdmin && (
            <button className="dx-secondary" type="button" onClick={handleOpenSettings}>
              <SettingsIcon />
              {t("pipeline.settings", locale)}
            </button>
          )}
          <button className="dx-primary" type="button" onClick={() => setAddLeadOpen(true)}>
            <Plus />
            {t("pipeline.addLead", locale)}
          </button>
        </div>
      </div>

      {/* ── Active contract from this week's deliberation ── */}
      <ActiveContractCard />

      {/* ── Missions banner ── */}
      <MissionsBanner />

      {/* ── Stat strip ── */}
      <div className="dx-stat-strip">
        {statDefs.map((s) => (
          <StatCard key={s.label} stat={s} />
        ))}
      </div>

      {/* ── Page tabs (Leads / Channels / Sales) ── */}
      <div className="dx-page-tabs">
        {(["leads", "channels", "sales"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`dx-page-tab ${activeTab === tab ? "active" : ""}`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* ════ LEADS ════ */}
      {activeTab === "leads" && (
        <>
          {/* Channel filter bar — only render when multiple channels
              have leads. With one channel active it's just visual
              noise. */}
          {CHANNELS_L.filter((c) => c.key !== "all" && channelCounts[c.key] > 0).length > 1 && (
            <div className="dx-channel-bar">
              {CHANNELS_L.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setChannelFilter(c.key)}
                  className={`dx-ch-tab ${channelFilter === c.key ? "active" : ""}`}
                >
                  <ChannelIcon ch={c.key} />
                  {c.label}
                  <span className="dx-ch-count">{channelCounts[c.key].toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}

          {/* Stream toolbar — mode chips (Browse/Review/Bulk),
              status chips, rep pills, sort. One row instead of three. */}
          <div className="dx-stream-toolbar">
            <div className="dx-chip-group" role="tablist" aria-label="Send mode" style={{ marginRight: 8 }}>
              {SEND_MODES_L.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  role="tab"
                  aria-selected={sendMode === m.key}
                  onClick={() => setSendMode(m.key)}
                  className={`dx-chip ${sendMode === m.key ? "active" : ""}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {sendMode !== "browse" && (
              <span className="dx-mode-hint" style={{ marginLeft: 0, marginRight: 12 }}>
                {sendMode === "review"
                  ? "J/K · Cmd+Enter to send"
                  : "Select rows then confirm"}
              </span>
            )}

            <div className="dx-chip-group">
              {STATUS_CHIPS_L.map((s) => {
                // Counts come from /api/pipeline/status-counts (canonical-
                // counts). NEVER recompute these from leads.filter() —
                // that's the paginated render slice and can show "0
                // Ready" while the DB has 1207 ready (caught 2026-05-16).
                //
                // repFilter: when admin filters down to one rep client-
                // side, the chip count still reflects the session-wide
                // scope. That's the right behavior — switching the chip
                // count when you filter by rep would mean the count
                // changes meaning ("ready in scope" vs "ready for this
                // rep"). If a per-rep breakdown is needed, the endpoint
                // takes ?rep_id=N — wire that into the URL when admin
                // changes the dropdown.
                const sc = statusCounts;
                const count = (() => {
                  if (!sc) return 0;
                  if (s.key === "all") return sc.total;
                  if (s.key === "drafting") return (sc.byStatus.queued ?? 0) + (sc.byStatus.drafting ?? 0) + (sc.byStatus.new ?? 0);
                  if (s.key === "ripening") return sc.ready.ripening;
                  if (s.key === "ready") return sc.ready.sendable;
                  return sc.byStatus[s.key] ?? 0;
                })();
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setStatusFilter(s.key)}
                    className={`dx-chip ${statusFilter === s.key ? "active" : ""}`}
                  >
                    {s.label}
                    {count > 0 && <span className="dx-ch-count" style={{ marginLeft: 6 }}>{count}</span>}
                  </button>
                );
              })}
            </div>

            {reps.length > 0 && isAdmin && (
              <div className="dx-rep-pills">
                {reps.map((r) => {
                  const palette = paletteFor(r.name);
                  const active = repFilter === r.id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setRepFilter(active ? "all" : r.id)}
                      className={`dx-rep-pill ${active ? "active" : ""}`}
                    >
                      <span className="dx-rp-dot" style={{ background: palette.solid }}>
                        {initialsFor(r.name).slice(0, 1)}
                      </span>
                      {r.name}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="dx-toolbar-spacer" />

            <select
              className="dx-select-light"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Sort cards"
            >
              {SORT_OPTIONS_L.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Batch send banner — only meaningful when arXiv-ready slice is visible */}
          {sendMode === "browse" && showArxiv && batchLeads.length > 0 && (statusFilter === "all" || statusFilter === "ready") && (
            <div className="action-banner" style={{ marginBottom: 16, marginTop: 4 }}>
              <div className="action-banner-icon">
                <Send style={{ width: 18, height: 18 }} />
              </div>
              <div className="action-banner-body">
                <p className="action-banner-title">
                  {batchLeads.length} ready to send
                </p>
                <div className="action-banner-meta">
                  <span>
                    <span className="action-banner-dot" style={{ background: "var(--gold)" }} />
                    {batchStrong} strong
                  </span>
                  <span>
                    <span className="action-banner-dot" style={{ background: "#93C5FD" }} />
                    {batchNormal} normal
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setSendMode("review")}
                  className="dx-secondary"
                  title="Review one-by-one (paper on left, draft on right)"
                >
                  Review batch
                </button>
                <button onClick={handleBatchSend} disabled={batchSending} className="dx-primary">
                  {batchSending ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : <Send />}
                  {batchSending ? "Sending…" : `Send all (${batchLeads.length})`}
                </button>
              </div>
            </div>
          )}

          {/* Review / Bulk modes replace the Browse stream entirely. */}
          {sendMode === "review" && !loading && (
            <ReviewPane
              leads={sortedArxiv}
              initialLeadId={typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("lead") : null}
              onExit={() => setSendMode("browse")}
              onSent={(lead) => {
                toast({ variant: "success", title: "Email sent", description: lead.authorEmail });
                fetchLeads();
              }}
              onSkipped={() => fetchLeads()}
            />
          )}
          {sendMode === "bulk" && !loading && (
            <BulkPane
              leads={sortedArxiv}
              onDone={(sent, skipped) => {
                toast({
                  variant: "success",
                  title: `Sent ${sent}`,
                  description: skipped ? `${skipped} skipped` : undefined,
                });
                fetchLeads();
              }}
              onError={(msg) => toast({ variant: "error", title: "Batch send failed", description: msg })}
            />
          )}

          {/* Browse-mode stream */}
          {sendMode === "browse" && (
          <div className="dx-stream">
            {loading ? (
              <>
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="skeleton" style={{ height: 130 }} />
                ))}
              </>
            ) : showPHOnboarding ? (
              <div className="dx-empty">
                <div className="dx-empty-glyph">PH</div>
                <div className="dx-empty-body">
                  <div className="dx-empty-title">Product Hunt is just getting started</div>
                  <div className="dx-empty-text">
                    {channelCounts.ph === 0
                      ? "We haven't ingested any Product Hunt makers yet. Connect your Product Hunt API key in Settings — we'll watch daily launches for Chinese-rooted makers and queue them here. Average channel volume after week 1: ~8 leads/day."
                      : `${channelCounts.ph} Product Hunt makers in the funnel — none match the current filters. Adjust the rep filter or check back after the next scrape.`}
                  </div>
                </div>
                <div className="dx-empty-actions">
                  <button className="dx-secondary" type="button" onClick={handleOpenSettings}>Learn more</button>
                  <button className="dx-primary" type="button" onClick={handleOpenSettings}>
                    <Globe />
                    Connect PH
                  </button>
                </div>
              </div>
            ) : allEmpty ? (
              <div className="dx-empty">
                <div className="dx-empty-glyph" style={{ background: "linear-gradient(135deg, #F0EFE9, #E8E7E1)", color: "var(--dx-text-2)" }}>
                  <Star style={{ width: 22, height: 22 }} />
                </div>
                <div className="dx-empty-body">
                  <div className="dx-empty-title">
                    {channelFilter === "all"
                      ? "No leads yet"
                      : `No ${CHANNELS_L.find((c) => c.key === channelFilter)?.label} leads`}
                  </div>
                  <div className="dx-empty-text">
                    {channelFilter === "arxiv" || channelFilter === "all"
                      ? 'Click "Scan arXiv" above to discover today\u2019s papers, or add a lead manually.'
                      : "No leads match the current filter combination. Try widening status or rep filters."}
                  </div>
                </div>
                <div className="dx-empty-actions">
                  <button className="dx-secondary" type="button" onClick={() => setAddLeadOpen(true)}>
                    <Plus />
                    Add lead
                  </button>
                  <button className="dx-primary" type="button" onClick={handleScan} disabled={scanning}>
                    {scanning ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : <Zap />}
                    Scan arXiv
                  </button>
                </div>
              </div>
            ) : (
              <>
                {showArxiv && sortedArxiv.map((lead) => (
                  <LeadRow
                    key={lead.id}
                    lead={lead}
                    reps={reps}
                    isExpanded={expanded === lead.id}
                    isExcluded={excluded.has(lead.id)}
                    isSending={sending === lead.id}
                    showStatusBadge={statusFilter === "all"}
                    onToggleExpand={handleToggleExpand}
                    onToggleExclude={handleToggleExclude}
                    onSend={handleSend}
                    onSkip={handleSkip}
                    onRepChange={handleRepChange}
                    onSaveEdit={handleSaveEdit}
                  />
                ))}
                {sortedDiscovery.map((d) => (
                  <DiscoveryCard
                    key={`${d.source}:${d.id}`}
                    lead={d}
                    onAction={handleDiscoveryAction}
                    onPromoted={handleDiscoveryPromoted}
                  />
                ))}
              </>
            )}
          </div>
          )}
        </>
      )}

      {activeTab === "channels" && (analytics ? <ChannelsTab analytics={analytics} /> : <TabLoader />)}
      {activeTab === "sales" && (analytics ? <SalesTab analytics={analytics} /> : <TabLoader />)}

      <AddLeadModal
        open={addLeadOpen}
        onClose={() => setAddLeadOpen(false)}
        onCreated={handleLeadCreated}
      />

      {reassignOpen && (
        <ReassignModal
          reps={reps}
          onClose={() => setReassignOpen(false)}
          onAutoRouteAll={handleReassignAll}
          onSuccess={() => fetchLeads()}
          toast={toast}
        />
      )}
    </div>
  );
}

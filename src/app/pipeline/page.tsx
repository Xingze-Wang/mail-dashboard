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
import { paletteFor, initialsFor } from "./repColors";
import { isAgeGated } from "@/lib/policy";

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
  { key: "all",     label: "All status" },
  { key: "ready",   label: "Ready" },
  { key: "new",     label: "New" },
  { key: "sent",    label: "Sent" },
  { key: "replied", label: "Replied" },
  { key: "skipped", label: "Skipped" },
] as const;
type StatusKey = (typeof STATUS_CHIPS)[number]["key"];

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

  const [addLeadOpen, setAddLeadOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [myRepId, setMyRepId] = useState<number | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);

  const [leads, setLeads] = useState<Lead[]>([]);
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

  /* ── Fetchers ────────────────────────────────────────────────────── */

  const fetchLeads = useCallback(
    (signal?: AbortSignal) => {
      if (!hasInitialised.current) setLoading(true);
      else setRefreshing(true);
      return fetch(`/api/pipeline?limit=200`, { signal })
        .then((r) => r.json())
        .then((data) => {
          setLeads(data.leads || []);
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
    fetchLeads(ctrl.signal);
    fetchDiscovery(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchLeads, fetchDiscovery]);

  // If anything is queued/drafting, kick the worker + refetch every 15s until
  // it drains. The worker is idempotent and only processes 5 at a time.
  const pending = useMemo(
    () => leads.filter((l) => l.status === "queued" || l.status === "drafting").length,
    [leads],
  );
  useEffect(() => {
    if (pending === 0) return;
    const tick = async () => {
      try {
        await fetch("/api/pipeline/draft-queue", { method: "POST" });
      } catch { /* ignore */ }
      fetchLeads();
    };
    tick();
    const iv = setInterval(tick, 15000);
    return () => clearInterval(iv);
  }, [pending, fetchLeads]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/sales-reps", { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => setReps(d.reps || []))
      .catch((err) => { if (err.name !== "AbortError") console.error(err); });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    if (analytics || analyticsLoading) return;
    const ctrl = new AbortController();
    setAnalyticsLoading(true);
    fetch("/api/pipeline/analytics", { signal: ctrl.signal })
      .then((r) => r.json())
      .then((a: Analytics) => setAnalytics(a))
      .catch((err) => { if (err.name !== "AbortError") console.error(err); })
      .finally(() => setAnalyticsLoading(false));
    return () => ctrl.abort();
  }, [analytics, analyticsLoading]);

  const refreshAnalytics = useCallback(() => setAnalytics(null), []);

  /* ── Channel counts ──────────────────────────────────────────────── */

  const channelCounts = useMemo(() => {
    const arxivTotal = analytics?.channels.sources.find((s) => s.source === "arXiv")?.total ?? leads.length;
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
  }, [analytics, leads.length, discoveryBySource]);

  /* ── Filtered + sorted streams ───────────────────────────────────── */

  const filteredArxivLeads = useMemo(() => {
    let result = leads;
    if (statusFilter !== "all") {
      result = result.filter((l) => {
        if (statusFilter === "ready" && l.status !== "ready") return false;
        if (statusFilter === "new" && l.status !== "new") return false;
        if (statusFilter === "sent" && l.status !== "sent") return false;
        if (statusFilter === "replied" && l.status !== "replied") return false;
        if (statusFilter === "skipped" && l.status !== "skipped") return false;
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
        case "score":
          return (b.citationCount ?? 0) - (a.citationCount ?? 0);
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
    setSending(lead.id);
    try {
      const res = await fetch("/api/pipeline/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id, override: override === true }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ variant: "error", title: "Send failed", description: data.error });
      } else {
        toast({ variant: "success", title: "Email sent", description: lead.authorEmail });
        fetchLeads();
      }
    } catch {
      toast({ variant: "error", title: "Send failed", description: "Network error" });
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

  const handleSkip = useCallback(async (id: string) => {
    await fetch(`/api/pipeline/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "skipped" }),
    });
    fetchLeads();
  }, [fetchLeads]);

  const handleSaveEdit = useCallback(async (id: string, draftSubject: string, draftHtml: string) => {
    await fetch(`/api/pipeline/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftSubject, draftHtml }),
    });
    toast({ variant: "success", title: "Draft saved" });
    fetchLeads();
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
    const ch = analytics?.channels;
    const totalLeads = (ch?.totalLeads ?? leads.length) + (discoveryBySource.hf + discoveryBySource.github + discoveryBySource.ph);
    const thisWeek = ch?.leadsThisWeek ?? 0;
    const sent = ch?.sentLeads ?? 0;
    const ready = leads.filter((l) => l.status === "ready").length;
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
        trend: { kind: thisWeek > 0 ? "up" : "flat", text: thisWeek > 0 ? "+new" : "±0" },
        spark: { color: "#1D4ED8", points: sparkPoints },
      },
      {
        label: "Ready to send",
        value: String(ready),
        unit: leads.length > 0 ? `/${leads.length}` : undefined,
        trend: ready > 0 ? { kind: "up", text: `+${ready}` } : { kind: "flat", text: "±0" },
        spark: { color: "#B45309", points: sparkPoints },
      },
      {
        label: "Sent · 7d",
        value: String(sent),
        trend: { kind: "flat", text: "±0" },
        spark: { color: "#5A5A56", points: sparkPoints },
      },
      {
        label: "Reply rate",
        value: conv.toFixed(1),
        unit: "%",
        trend: conv > 0 ? { kind: "up", text: `${conv.toFixed(1)}%` } : { kind: "flat", text: "0%" },
        spark: { color: "#6D28D9", points: sparkPoints },
      },
    ];
  }, [analytics, leads, discoveryBySource]);

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
            Pipeline
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
            <button onClick={handleReassignAll} className="dx-secondary">
              Re-assign
            </button>
          )}
          <button onClick={handleScan} disabled={scanning} className="dx-secondary">
            {scanning ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : <Zap />}
            {scanning ? "Scanning…" : "Scan arXiv"}
          </button>
          <button className="dx-secondary" type="button" onClick={handleExport}>
            <Download />
            Export
          </button>
          {isAdmin && (
            <button className="dx-secondary" type="button" onClick={handleOpenSettings}>
              <SettingsIcon />
              Settings
            </button>
          )}
          <button className="dx-primary" type="button" onClick={() => setAddLeadOpen(true)}>
            <Plus />
            Add lead
          </button>
        </div>
      </div>

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
          {/* Send-mode toggle (Browse / Review / Bulk) */}
          <div className="dx-mode-row">
            <span className="dx-mode-label">Mode</span>
            <div className="dx-chip-group" role="tablist" aria-label="Send mode">
              {SEND_MODES.map((m) => (
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
              <span className="dx-mode-hint">
                {sendMode === "review"
                  ? "Focused review · J/K to navigate · Cmd+Enter to send"
                  : "Bulk send · select rows then confirm"}
              </span>
            )}
          </div>

          {/* Channel filter bar */}
          <div className="dx-channel-bar">
            {CHANNELS.map((c) => (
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

          {/* Stream toolbar */}
          <div className="dx-stream-toolbar">
            <div className="dx-chip-group">
              {STATUS_CHIPS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setStatusFilter(s.key)}
                  className={`dx-chip ${statusFilter === s.key ? "active" : ""}`}
                >
                  {s.label}
                </button>
              ))}
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
              {SORT_OPTIONS.map((o) => (
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
              <button onClick={handleBatchSend} disabled={batchSending} className="dx-primary">
                {batchSending ? <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" /> : <Send />}
                {batchSending ? "Sending…" : `Send all (${batchLeads.length})`}
              </button>
            </div>
          )}

          {/* Review / Bulk modes replace the Browse stream entirely. */}
          {sendMode === "review" && !loading && (
            <ReviewPane
              leads={sortedArxiv}
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
                      : `No ${CHANNELS.find((c) => c.key === channelFilter)?.label} leads`}
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
    </div>
  );
}

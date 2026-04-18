"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Zap, Send, Loader2, Download, Settings as SettingsIcon, Plus } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useToast } from "@/components/ui/toaster";
import { RESEARCH_CATEGORIES, getLeadCategories } from "@/lib/directions";
import { Analytics, Lead, Rep, canSend, shortDate } from "./types";
import { LeadRow } from "./LeadRow";
import { AddLeadModal } from "./AddLeadModal";

const ChannelsTab = dynamic(() => import("./ChannelsTab").then((m) => m.ChannelsTab), {
  loading: () => <TabLoader />,
});
const SalesTab = dynamic(() => import("./SalesTab").then((m) => m.SalesTab), {
  loading: () => <TabLoader />,
});

/* ── CSV export helpers ─────────────────────────────────────────────── */

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // RFC 4180: wrap in quotes if it contains ", , or newline; double up internal quotes.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function leadsToCsv(leads: Lead[], reps: Rep[]): string {
  const repName = (id: number | null) =>
    id == null ? "" : reps.find((r) => r.id === id)?.name ?? `#${id}`;
  const rows = [
    [
      "title", "author", "email", "school",
      "hIndex", "citations", "tier", "status", "sentAt", "repName",
    ],
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
  // Free memory after the click is processed.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function TabLoader() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 88 }} />
      ))}
    </div>
  );
}

const STATUS_FILTERS = [
  { key: "all",     label: "All" },
  { key: "ready",   label: "Ready" },
  { key: "new",     label: "New" },
  { key: "sent",    label: "Sent" },
  { key: "replied", label: "Replied" },
  { key: "skipped", label: "Skipped" },
] as const;

const DATE_FILTERS = [
  { key: "today", label: "Today" },
  { key: "week",  label: "This Week" },
  { key: "all",   label: "All Time" },
] as const;

type StatusKey = (typeof STATUS_FILTERS)[number]["key"];
type DateKey = (typeof DATE_FILTERS)[number]["key"];

export default function PipelinePage() {
  const { toast } = useToast();
  const router = useRouter();

  const [addLeadOpen, setAddLeadOpen] = useState(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusKey>("all");
  const [tierFilter, setTierFilter] = useState("all");
  const [repFilter, setRepFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [dateRange, setDateRange] = useState<DateKey>("today");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [batchSending, setBatchSending] = useState(false);
  const [activeTab, setActiveTab] = useState<"leads" | "channels" | "sales">("leads");
  const [reps, setReps] = useState<Rep[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  const hasInitialised = useRef(false);

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 180);
    return () => clearTimeout(h);
  }, [searchQuery]);

  const fetchLeads = useCallback(
    (signal?: AbortSignal) => {
      if (!hasInitialised.current) setLoading(true);
      else setRefreshing(true);

      const params = new URLSearchParams({ limit: "200" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (tierFilter !== "all") params.set("tier", tierFilter);
      if (repFilter !== "all") params.set("rep_id", repFilter);
      if (dateRange !== "all") params.set("date", dateRange);

      return fetch(`/api/pipeline?${params}`, { signal })
        .then((r) => r.json())
        .then((data) => {
          setLeads(data.leads || []);
          setTotal(data.total || 0);
        })
        .catch((err) => {
          if (err.name !== "AbortError") console.error(err);
        })
        .finally(() => {
          hasInitialised.current = true;
          setLoading(false);
          setRefreshing(false);
        });
    },
    [statusFilter, tierFilter, repFilter, dateRange],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    fetchLeads(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchLeads]);

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

  const filteredLeads = useMemo(() => {
    let result = leads;
    if (categoryFilter !== "all") {
      result = result.filter((l) => getLeadCategories(l.matchedDirections).includes(categoryFilter as never));
    }
    if (debouncedQuery) {
      const q = debouncedQuery.toLowerCase();
      result = result.filter(
        (l) =>
          l.title.toLowerCase().includes(q) ||
          l.authorName?.toLowerCase().includes(q) ||
          l.authorEmail.toLowerCase().includes(q) ||
          l.schoolName?.toLowerCase().includes(q),
      );
    }
    return result;
  }, [leads, debouncedQuery, categoryFilter]);

  const batchLeads = useMemo(
    () => filteredLeads.filter((l) => canSend(l).ok && !excluded.has(l.id)),
    [filteredLeads, excluded],
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

  const handleSend = useCallback(async (lead: Lead) => {
    setSending(lead.id);
    try {
      const res = await fetch("/api/pipeline/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id }),
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
    if (filteredLeads.length === 0) {
      toast({ variant: "info", title: "Nothing to export", description: "No leads match the current filters." });
      return;
    }
    const today = shortDate(new Date().toISOString())
      .toLowerCase()
      .replace(/,?\s+/g, "-");
    downloadCsv(`pipeline-${today}.csv`, leadsToCsv(filteredLeads, reps));
    toast({
      variant: "success",
      title: `Exported ${filteredLeads.length} leads`,
      description: `pipeline-${today}.csv`,
    });
  }, [filteredLeads, reps, toast]);

  const handleOpenSettings = useCallback(() => {
    router.push("/settings#assignment");
  }, [router]);

  const handleLeadCreated = useCallback(() => {
    toast({ variant: "success", title: "Lead added" });
    fetchLeads();
    refreshAnalytics();
  }, [fetchLeads, refreshAnalytics, toast]);

  const headerCount = total || filteredLeads.length;
  const dateSuffix =
    dateRange === "today" ? " today" : dateRange === "week" ? " this week" : "";

  return (
    <div>
      {/* ── Page Header ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 className="page-title">Pipeline</h1>
          <span className="lead-count">{headerCount} leads{dateSuffix}</span>
          {refreshing && <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: "var(--text-tertiary)" }} />}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={handleReassignAll} className="btn">Re-assign</button>
          <button onClick={handleScan} disabled={scanning} className="btn">
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap />}
            {scanning ? "Scanning…" : "Scan arXiv"}
          </button>
          <button className="btn" type="button" onClick={handleExport}>
            <Download />
            Export
          </button>
          <button className="btn" type="button" onClick={handleOpenSettings}>
            <SettingsIcon />
            Settings
          </button>
          <button className="btn btn-primary" type="button" onClick={() => setAddLeadOpen(true)}>
            <Plus />
            Add Lead
          </button>
        </div>
      </div>

      {/* ── Page Tabs ── */}
      <div className="page-tabs" style={{ marginBottom: 28 }}>
        {(["leads", "channels", "sales"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`page-tab ${activeTab === tab ? "active" : ""}`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* ════ LEADS ════ */}
      {activeTab === "leads" && (
        <>
          {/* Batch send banner */}
          {batchLeads.length > 0 &&
            statusFilter !== "sent" &&
            statusFilter !== "skipped" &&
            statusFilter !== "replied" && (
              <div className="action-banner">
                <div className="action-banner-icon">
                  <Send style={{ width: 18, height: 18 }} />
                </div>
                <div className="action-banner-body">
                  <p className="action-banner-title">
                    {dateRange === "today" ? "Today’s Batch" : dateRange === "week" ? "This Week" : "All Leads"} — {batchLeads.length} ready to send
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
                <button onClick={handleBatchSend} disabled={batchSending} className="btn btn-primary">
                  {batchSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send />}
                  {batchSending ? "Sending…" : `Send All (${batchLeads.length})`}
                </button>
              </div>
            )}

          {/* ── Filter Bar ── */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
            <SegmentedControl value={dateRange} onChange={setDateRange} options={DATE_FILTERS} />
            <div className="filter-divider" />
            <SegmentedControl value={statusFilter} onChange={setStatusFilter} options={STATUS_FILTERS} />

            <select className="filter-select" value={tierFilter} onChange={(e) => setTierFilter(e.target.value)}>
              <option value="all">All Tiers</option>
              <option value="strong">Strong</option>
              <option value="normal">Normal</option>
            </select>

            <select className="filter-select" value={repFilter} onChange={(e) => setRepFilter(e.target.value)}>
              <option value="all">All Reps</option>
              {reps.map((r) => (
                <option key={r.id} value={String(r.id)}>{r.name}</option>
              ))}
            </select>

            <select className="filter-select" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="all">All Categories</option>
              {RESEARCH_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>

            <div style={{ marginLeft: "auto" }}>
              <input
                type="text"
                className="search-input"
                placeholder="Search leads…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          {/* ── List ── */}
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="skeleton" style={{ height: 110 }} />
              ))}
            </div>
          ) : filteredLeads.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">
                <Zap style={{ width: 20, height: 20 }} />
              </div>
              <h3>
                {dateRange === "today"
                  ? "Nothing today yet"
                  : dateRange === "week"
                    ? "Nothing this week"
                    : statusFilter === "all"
                      ? "No leads yet"
                      : `No ${statusFilter} leads`}
              </h3>
              <p>
                {dateRange === "today"
                  ? 'Click "Scan arXiv" above to discover today\u2019s papers.'
                  : dateRange === "week"
                    ? "No leads matched the current filters."
                    : statusFilter === "all"
                      ? 'Click "Scan arXiv" above to find papers.'
                      : "Try widening your filters or check back later."}
              </p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {filteredLeads.map((lead) => (
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
            </div>
          )}
        </>
      )}

      {activeTab === "channels" && (analytics ? <ChannelsTab analytics={analytics} /> : <TabLoader />)}
      {activeTab === "sales"    && (analytics ? <SalesTab analytics={analytics} />    : <TabLoader />)}

      <AddLeadModal
        open={addLeadOpen}
        onClose={() => setAddLeadOpen(false)}
        onCreated={handleLeadCreated}
      />
    </div>
  );
}

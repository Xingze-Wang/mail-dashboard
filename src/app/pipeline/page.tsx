"use client";

// Email draft previews are sanitized via sanitizeHtml() which uses DOMPurify

import { useEffect, useState, useMemo, useCallback } from "react";
import {
  Zap,
  Send,
  ExternalLink,
  Clock,
  Loader2,
  ChevronDown,
  ChevronUp,
  Pencil,
  BarChart3,
  TrendingUp,
  MessageCircle,
  Search,
  X,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { formatDate } from "@/lib/utils";
import { sanitizeHtml } from "@/lib/sanitize";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Lead {
  id: string;
  arxivId: string;
  title: string;
  abstract: string | null;
  authors: string | null;
  pdfUrl: string | null;
  publishedAt: string | null;
  authorName: string | null;
  authorEmail: string;
  firstName: string | null;
  schoolName: string | null;
  schoolTier: number | null;
  computeLevel: string | null;
  computeConfidence: number | null;
  computeReason: string | null;
  matchedDirections: string | null;
  draftSubject: string | null;
  draftHtml: string | null;
  status: string;
  createdAt: string;
  sentAt: string | null;
  hIndex: number | null;
  citationCount: number | null;
  paperCount: number | null;
  leadTier: string | null;
  assignedRepId: number | null;
  s2AuthorId: string | null;
}

interface Rep {
  id: number;
  name: string;
  sender_email: string;
  sender_name: string;
  wechat_id: string;
  active: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Analytics {
  channels: {
    totalLeads: number;
    strongLeads: number;
    leadsThisWeek: number;
    avgHIndex: number;
    sentLeads: number;
    wechatCount: number;
    conversionRate: number;
    daily: { date: string; strong: number; normal: number }[];
    hIndexDist: { min: number; max: number | null; count: number }[];
    sources: any[];
  };
  sales: {
    reps: {
      rep: { id: number; name: string; sender_email: string; wechat_id: string; active: boolean };
      assigned: number;
      sent: number;
      replied: number;
      wechat: number;
      convRate: number;
      tiers: { tier: string; assigned: number; sent: number; replied: number; wechat: number; convRate: number }[];
    }[];
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Helpers ────────────────────────────────────────────────────────────────

function tierBadgeClass(tier: string | null) {
  return tier === "strong"
    ? "bg-orange-500/15 text-orange-400"
    : "bg-white/[0.06] text-neutral-500";
}

function computeBadgeClass(level: string | null) {
  switch (level) {
    case "heavy": return "bg-red-500/15 text-red-400";
    case "moderate": return "bg-yellow-500/15 text-yellow-400";
    case "light": return "bg-green-500/15 text-green-400";
    default: return "bg-white/[0.06] text-neutral-500";
  }
}

function statusBadgeClass(status: string) {
  switch (status) {
    case "ready": return "bg-blue-500/15 text-blue-400";
    case "sent": return "bg-green-500/15 text-green-400";
    case "skipped": return "bg-white/[0.06] text-neutral-500";
    case "replied": return "bg-purple-500/15 text-purple-400";
    default: return "bg-yellow-500/15 text-yellow-400";
  }
}

function canSend(lead: Lead): { ok: boolean; reason?: string; availableIn?: string } {
  if (lead.status !== "ready") return { ok: false, reason: "Not ready" };
  if (!lead.draftHtml) return { ok: false, reason: "No draft" };
  if (!lead.publishedAt) return { ok: true };

  const pub = new Date(lead.publishedAt);
  const now = new Date();
  const ageMs = now.getTime() - pub.getTime();
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (ageMs < oneDayMs) {
    const hoursLeft = Math.ceil((oneDayMs - ageMs) / 3600000);
    return { ok: false, reason: "Too new", availableIn: `${hoursLeft}h` };
  }
  return { ok: true };
}

function shortDate(dateStr: string | null) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// ─── Filter tabs ────────────────────────────────────────────────────────────

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "ready", label: "Ready" },
  { key: "new", label: "New" },
  { key: "sent", label: "Sent" },
  { key: "replied", label: "Replied" },
  { key: "skipped", label: "Skipped" },
];

// ─── Suppress unused import warning (formatDate used in expanded view) ─────
void formatDate;

// ─── Page ───────────────────────────────────────────────────────────────────

export default function PipelinePage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [tierFilter, setTierFilter] = useState("all");
  const [repFilter, setRepFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editHtml, setEditHtml] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [batchSending, setBatchSending] = useState(false);
  const [activeTab, setActiveTab] = useState<"leads" | "channels" | "sales">("leads");
  const [reps, setReps] = useState<Rep[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  // ── Data fetching ──

  const fetchLeads = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: "100" });
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (tierFilter !== "all") params.set("tier", tierFilter);
    if (repFilter !== "all") params.set("rep_id", repFilter);

    fetch(`/api/pipeline?${params}`)
      .then((res) => res.json())
      .then((data) => {
        setLeads(data.leads || []);
        setTotal(data.total || 0);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [statusFilter, tierFilter, repFilter]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  useEffect(() => {
    fetch("/api/sales-reps")
      .then((r) => r.json())
      .then((d) => setReps(d.reps || []))
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (activeTab !== "leads") {
      fetch("/api/pipeline/analytics")
        .then((r) => r.json())
        .then(setAnalytics)
        .catch(console.error);
    }
  }, [activeTab]);

  // ── Filtered leads (client-side search) ──

  const filteredLeads = useMemo(() => {
    if (!searchQuery.trim()) return leads;
    const q = searchQuery.toLowerCase();
    return leads.filter(
      (l) =>
        l.title.toLowerCase().includes(q) ||
        l.authorName?.toLowerCase().includes(q) ||
        l.authorEmail.toLowerCase().includes(q) ||
        l.schoolName?.toLowerCase().includes(q),
    );
  }, [leads, searchQuery]);

  // ── Batch stats ──

  const batchLeads = useMemo(
    () => filteredLeads.filter((l) => canSend(l).ok && !excluded.has(l.id)),
    [filteredLeads, excluded],
  );
  const batchStrong = batchLeads.filter((l) => l.leadTier === "strong").length;
  const batchNormal = batchLeads.length - batchStrong;

  const batchByRep = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of batchLeads) {
      const rep = reps.find((r) => r.id === l.assignedRepId);
      const name = rep?.name || "Unassigned";
      map.set(name, (map.get(name) || 0) + 1);
    }
    return [...map.entries()];
  }, [batchLeads, reps]);

  // ── Actions ──

  const handleRepChange = async (leadId: string, repId: number) => {
    await fetch(`/api/pipeline/${leadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedRepId: repId }),
    });
    fetchLeads();
  };

  const handleScan = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const res = await fetch("/api/pipeline/scan", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setScanResult(`Found ${data.leadsCreated} new leads (scanned ${data.stats?.checked || 0} papers)`);
        fetchLeads();
      } else {
        setScanResult(`Error: ${data.error}`);
      }
    } catch {
      setScanResult("Scan failed");
    } finally {
      setScanning(false);
    }
  };

  const handleSend = async (lead: Lead) => {
    setSending(lead.id);
    try {
      const res = await fetch("/api/pipeline/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id }),
      });
      const data = await res.json();
      if (!res.ok) alert(`Send failed: ${data.error}`);
      else fetchLeads();
    } catch {
      alert("Send failed");
    } finally {
      setSending(null);
    }
  };

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
        alert(`Sent ${data.sent}, skipped ${data.skipped}`);
        setExcluded(new Set());
        fetchLeads();
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch {
      alert("Batch send failed");
    } finally {
      setBatchSending(false);
    }
  };

  const handleSkip = async (id: string) => {
    await fetch(`/api/pipeline/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "skipped" }),
    });
    fetchLeads();
  };

  const handleSaveEdit = async (id: string) => {
    await fetch(`/api/pipeline/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftSubject: editSubject, draftHtml: editHtml }),
    });
    setEditing(null);
    fetchLeads();
  };

  const startEdit = (lead: Lead) => {
    setEditing(lead.id);
    setEditSubject(lead.draftSubject || "");
    setEditHtml(lead.draftHtml || "");
  };

  const toggleExclude = (id: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleReassignAll = async () => {
    try {
      const res = await fetch("/api/config/assignment", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        alert(`Re-assigned ${data.reassigned} leads`);
        fetchLeads();
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch {
      alert("Re-assign failed");
    }
  };

  // ── Render ──

  return (
    <div>
      {/* ── Page Header ── */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
          <span className="text-base text-neutral-500 font-normal">{total || filteredLeads.length} leads</span>
        </div>
        <div className="flex items-center gap-2">
          {scanResult && (
            <span className={`text-xs mr-1 ${scanResult.startsWith("Error") ? "text-red-400" : "text-emerald-400"}`}>
              {scanResult}
            </span>
          )}
          <button
            onClick={handleReassignAll}
            className="rounded-lg border border-neutral-800 px-3.5 py-[7px] text-[13px] font-medium text-neutral-400 hover:text-white hover:bg-white/[0.05] transition-colors"
          >
            Re-assign All
          </button>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="rounded-lg bg-white px-3.5 py-[7px] text-[13px] font-medium text-black hover:bg-neutral-200 disabled:opacity-50 transition-colors flex items-center gap-1.5"
          >
            {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            {scanning ? "Scanning..." : "Scan arXiv"}
          </button>
        </div>
      </div>

      {/* ── Underline Tabs ── */}
      <div className="flex gap-0 border-b border-neutral-800 mb-4">
        {(["leads", "channels", "sales"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`relative px-5 py-2.5 text-[13px] font-medium transition-colors -mb-px ${
              activeTab === tab
                ? "text-white border-b-2 border-white"
                : "text-neutral-500 hover:text-neutral-300 border-b-2 border-transparent"
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
            {tab === "leads" && total > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full bg-white/[0.08] text-[11px] font-medium text-neutral-400">
                {total}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ═══════════════ LEADS TAB ═══════════════ */}
      {activeTab === "leads" && (
        <>
          {/* ── Batch Banner ── */}
          {batchLeads.length > 0 && statusFilter !== "sent" && statusFilter !== "skipped" && statusFilter !== "replied" && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 mb-5 flex items-center gap-5">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500/15 to-purple-500/15 flex items-center justify-center shrink-0">
                <Send className="h-5 w-5 text-blue-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[15px] font-semibold tracking-tight mb-1">
                  Today&apos;s Batch &mdash; {batchLeads.length} leads ready to send
                </p>
                <div className="flex items-center gap-4 text-xs text-neutral-500">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-orange-400" />
                    {batchStrong} strong
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                    {batchNormal} normal
                  </span>
                </div>
                {batchByRep.length > 0 && (
                  <div className="flex gap-2 mt-2">
                    {batchByRep.map(([name, count]) => (
                      <span key={name} className="text-[11px] text-neutral-500 bg-white/[0.03] rounded-md px-2 py-0.5">
                        {name}: <strong className="text-neutral-400 font-semibold">{count}</strong>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleBatchSend}
                  disabled={batchSending}
                  className="flex items-center gap-2 rounded-xl bg-green-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-green-500 disabled:opacity-50 transition-all hover:-translate-y-px hover:shadow-lg hover:shadow-green-500/20"
                >
                  {batchSending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  {batchSending ? "Sending..." : `Approve & Send All (${batchLeads.length})`}
                </button>
              </div>
            </div>
          )}

          {/* ── Filter Bar ── */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <div className="flex bg-white/[0.04] rounded-lg p-0.5">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setStatusFilter(f.key)}
                  className={`rounded-md px-3 py-[5px] text-xs font-medium transition-colors ${
                    statusFilter === f.key
                      ? "bg-neutral-800 text-white"
                      : "text-neutral-500 hover:text-neutral-300"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <select
              value={tierFilter}
              onChange={(e) => setTierFilter(e.target.value)}
              className="rounded-lg border border-neutral-800 bg-white/[0.04] px-3 py-[5px] text-xs text-neutral-400 appearance-none pr-7"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23737373' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E")`,
                backgroundRepeat: "no-repeat",
                backgroundPosition: "right 10px center",
              }}
            >
              <option value="all">All Tiers</option>
              <option value="strong">Strong</option>
              <option value="normal">Normal</option>
            </select>

            <select
              value={repFilter}
              onChange={(e) => setRepFilter(e.target.value)}
              className="rounded-lg border border-neutral-800 bg-white/[0.04] px-3 py-[5px] text-xs text-neutral-400 appearance-none pr-7"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23737373' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E")`,
                backgroundRepeat: "no-repeat",
                backgroundPosition: "right 10px center",
              }}
            >
              <option value="all">All Reps</option>
              {reps.map((r) => (
                <option key={r.id} value={String(r.id)}>{r.name}</option>
              ))}
            </select>

            <div className="flex-1" />

            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-600" />
              <input
                type="text"
                placeholder="Search leads..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="rounded-lg border border-neutral-800 bg-white/[0.04] pl-8 pr-3 py-[5px] text-xs text-white placeholder-neutral-600 w-[200px] focus:outline-none focus:border-neutral-600 transition-colors"
              />
            </div>
          </div>

          {/* ── Lead List ── */}
          {loading ? (
            <div className="text-center text-sm text-neutral-500 animate-pulse py-16">Loading...</div>
          ) : filteredLeads.length === 0 ? (
            <div className="text-center py-16">
              <Zap className="h-8 w-8 mx-auto mb-3 text-neutral-700" />
              <p className="text-sm text-neutral-500">
                {statusFilter === "all"
                  ? 'No leads yet. Click "Scan arXiv" to find papers.'
                  : `No ${statusFilter} leads.`}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filteredLeads.map((lead) => {
                const sendCheck = canSend(lead);
                const isExpanded = expanded === lead.id;
                const isEditing = editing === lead.id;
                const isExcluded = excluded.has(lead.id);
                const directions = lead.matchedDirections?.split(",").filter(Boolean) || [];
                // Draft HTML is sanitized with DOMPurify before rendering
                const sanitized = lead.draftHtml ? sanitizeHtml(lead.draftHtml) : "";

                return (
                  <div
                    key={lead.id}
                    className={`rounded-xl border border-neutral-800 bg-neutral-900/50 transition-all ${
                      isExcluded ? "opacity-40 border-transparent" : "hover:bg-neutral-800/40"
                    }`}
                  >
                    {/* Lead Header */}
                    <div
                      className="flex items-start gap-3 px-[18px] py-3.5 cursor-pointer"
                      onClick={() => setExpanded(isExpanded ? null : lead.id)}
                    >
                      {/* Left: badges + title + meta + tags */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          {statusFilter === "all" && (
                            <span className={`inline-flex items-center rounded-full px-2 py-px text-[10px] font-semibold uppercase tracking-wide ${statusBadgeClass(lead.status)}`}>
                              {lead.status}
                            </span>
                          )}
                          {lead.computeLevel && (
                            <span className={`inline-flex items-center rounded-full px-2 py-px text-[10px] font-semibold uppercase tracking-wide ${computeBadgeClass(lead.computeLevel)}`}>
                              {lead.computeLevel}
                            </span>
                          )}
                          {lead.leadTier && (
                            <span className={`inline-flex items-center rounded-full px-2 py-px text-[10px] font-semibold uppercase tracking-wide ${tierBadgeClass(lead.leadTier)}`}>
                              {lead.leadTier}
                            </span>
                          )}
                        </div>

                        <h3 className="text-[13px] font-medium text-white leading-snug mb-1 line-clamp-1">
                          {lead.title}
                        </h3>

                        <div className="flex items-center gap-3 text-[11px] text-neutral-500 flex-wrap">
                          <span>{lead.authorName || "Unknown"} · {lead.authorEmail}</span>
                          {lead.schoolName && <span>{lead.schoolName}</span>}
                          <span>{shortDate(lead.publishedAt || lead.createdAt)}</span>
                          {lead.sentAt && (
                            <span className="text-green-500">Sent {shortDate(lead.sentAt)}</span>
                          )}
                        </div>

                        {directions.length > 0 && (
                          <div className="flex gap-1 mt-1.5 flex-wrap">
                            {directions.map((d) => (
                              <span key={d} className="rounded bg-white/[0.05] px-1.5 py-px text-[10px] text-neutral-500">
                                {d}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Right: h-index, citations, rep dropdown, send/exclude */}
                      <div className="flex items-center gap-2.5 shrink-0 pt-0.5">
                        {lead.hIndex !== null && (
                          <span className="text-[11px] text-neutral-500 bg-white/[0.04] rounded px-1.5 py-0.5">
                            h: <strong className="text-neutral-400 font-semibold">{lead.hIndex}</strong>
                          </span>
                        )}
                        {lead.citationCount !== null && lead.citationCount > 0 && (
                          <span className="text-[11px] text-neutral-500 bg-white/[0.04] rounded px-1.5 py-0.5">
                            cit: <strong className="text-neutral-400 font-semibold">{lead.citationCount.toLocaleString()}</strong>
                          </span>
                        )}

                        {!sendCheck.ok && sendCheck.availableIn && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
                            <Clock className="h-3 w-3" />
                            {sendCheck.availableIn}
                          </span>
                        )}

                        {reps.length > 0 && (
                          <select
                            value={lead.assignedRepId ?? ""}
                            onChange={(e) => {
                              e.stopPropagation();
                              handleRepChange(lead.id, parseInt(e.target.value));
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="rounded-md border border-neutral-800 bg-white/[0.04] px-2 py-1 text-[11px] text-neutral-400 appearance-none pr-5"
                            style={{
                              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%23737373' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E")`,
                              backgroundRepeat: "no-repeat",
                              backgroundPosition: "right 6px center",
                            }}
                          >
                            {reps.map((r) => (
                              <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                          </select>
                        )}

                        {lead.status === "ready" && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleSend(lead); }}
                            disabled={!sendCheck.ok || sending === lead.id}
                            className="rounded-md bg-white px-2.5 py-1 text-[11px] font-medium text-black hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            {sending === lead.id ? (
                              <Loader2 className="h-3 w-3 animate-spin inline" />
                            ) : (
                              "Send"
                            )}
                          </button>
                        )}

                        {lead.status === "ready" && sendCheck.ok && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleExclude(lead.id); }}
                            className={`w-7 h-7 rounded-md border border-neutral-800 flex items-center justify-center text-neutral-500 hover:text-white hover:bg-white/[0.05] transition-colors ${
                              isExcluded ? "bg-white/[0.05]" : ""
                            }`}
                            title={isExcluded ? "Include in batch" : "Exclude from batch"}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}

                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4 text-neutral-600" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-neutral-600" />
                        )}
                      </div>
                    </div>

                    {/* Expanded Detail */}
                    {isExpanded && (
                      <div className="border-t border-neutral-800">
                        {lead.abstract && (
                          <div className="px-[18px] py-3 border-b border-neutral-800/50">
                            <p className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider mb-1">Abstract</p>
                            <p className="text-xs text-neutral-400 leading-relaxed">
                              {lead.abstract.slice(0, 400)}{lead.abstract.length > 400 ? "..." : ""}
                            </p>
                            {lead.pdfUrl && (
                              <a
                                href={lead.pdfUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 mt-2 text-[11px] text-blue-400 hover:text-blue-300"
                              >
                                <ExternalLink className="h-3 w-3" />
                                View on arXiv
                              </a>
                            )}
                          </div>
                        )}

                        {lead.computeReason && (
                          <div className="px-[18px] py-3 border-b border-neutral-800/50">
                            <p className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider mb-1">Why Compute</p>
                            <p className="text-xs text-neutral-400">{lead.computeReason}</p>
                          </div>
                        )}

                        <div className="px-[18px] py-4">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">Email Draft</p>
                            <div className="flex gap-2">
                              {lead.status === "ready" && !isEditing && (
                                <button
                                  onClick={() => startEdit(lead)}
                                  className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-white transition-colors"
                                >
                                  <Pencil className="h-3 w-3" />
                                  Edit
                                </button>
                              )}
                              {lead.status === "ready" && (
                                <button
                                  onClick={() => handleSkip(lead.id)}
                                  className="text-[11px] text-neutral-500 hover:text-white transition-colors"
                                >
                                  Skip
                                </button>
                              )}
                            </div>
                          </div>

                          {isEditing ? (
                            <div className="space-y-3">
                              <input
                                type="text"
                                value={editSubject}
                                onChange={(e) => setEditSubject(e.target.value)}
                                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] text-white focus:border-neutral-500 focus:outline-none"
                                placeholder="Subject"
                              />
                              <textarea
                                value={editHtml}
                                onChange={(e) => setEditHtml(e.target.value)}
                                rows={10}
                                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-white font-mono focus:border-neutral-500 focus:outline-none resize-none"
                              />
                              <div className="flex gap-2">
                                <button
                                  onClick={() => handleSaveEdit(lead.id)}
                                  className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-neutral-200 transition-colors"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => setEditing(null)}
                                  className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 hover:text-white transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : sanitized ? (
                            <>
                              <p className="text-xs text-neutral-300 mb-2">
                                Subject: {lead.draftSubject}
                              </p>
                              {/* Draft HTML is pre-sanitized with DOMPurify via sanitizeHtml() */}
                              <div
                                className="pipeline-email-preview rounded-lg bg-white p-4 text-[13px]"
                                dangerouslySetInnerHTML={{ __html: sanitized }}
                              />
                              <style>{`
                                .pipeline-email-preview, .pipeline-email-preview * { color: #1a1a1a !important; }
                                .pipeline-email-preview a { color: #2563eb !important; }
                              `}</style>
                            </>
                          ) : (
                            <p className="text-xs text-neutral-500 italic">No draft generated yet</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ═══════════════ CHANNELS TAB ═══════════════ */}
      {activeTab === "channels" && analytics && (
        <div className="space-y-4">
          {/* Stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "Total Leads", value: analytics.channels.totalLeads, sub: `+${analytics.channels.leadsThisWeek} this week` },
              { label: "Strong Leads", value: analytics.channels.strongLeads, sub: `${analytics.channels.totalLeads > 0 ? ((analytics.channels.strongLeads / analytics.channels.totalLeads) * 100).toFixed(1) : 0}% of total` },
              { label: "Avg h-index", value: analytics.channels.avgHIndex, sub: null },
              { label: "Send → WeChat", value: `${analytics.channels.conversionRate}%`, sub: null },
            ].map((card) => (
              <div key={card.label} className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
                <p className="text-xs font-medium text-neutral-500 mb-1.5">{card.label}</p>
                <p className="text-[28px] font-bold tracking-tight leading-none tabular-nums">{card.value}</p>
                {card.sub && <p className="text-[11px] text-neutral-600 mt-1">{card.sub}</p>}
              </div>
            ))}
          </div>

          {/* Daily chart */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <p className="text-[13px] font-semibold mb-4">Leads Discovered (Last 30 Days)</p>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={analytics.channels.daily}>
                <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
                <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} stroke="#525252" tick={{ fontSize: 11 }} />
                <YAxis stroke="#525252" tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={{ backgroundColor: "#171717", border: "1px solid #333", borderRadius: "8px", fontSize: "12px" }} />
                <Bar dataKey="normal" stackId="a" fill="rgba(59,130,246,0.5)" />
                <Bar dataKey="strong" stackId="a" fill="rgba(249,115,22,0.7)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Source table */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 overflow-hidden">
            <p className="text-[13px] font-semibold p-5 pb-3 border-b border-neutral-800">Source Breakdown</p>
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  {["Source", "Total", "Strong", "Normal", "Sent", "WeChat", "Conv %"].map((h) => (
                    <th key={h} className="text-left px-3.5 py-2.5 text-[11px] font-semibold text-neutral-500 uppercase tracking-wider border-b border-neutral-800">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {analytics.channels.sources.map((s: { source: string; total: number; strong: number; normal: number; sent: number; wechat: number; convRate: number }) => (
                  <tr key={s.source} className="border-t border-neutral-800/50 hover:bg-white/[0.02]">
                    <td className="px-3.5 py-3 font-medium text-white">{s.source}</td>
                    <td className="px-3.5 py-3 text-neutral-400">{s.total}</td>
                    <td className="px-3.5 py-3 text-neutral-400">{s.strong}</td>
                    <td className="px-3.5 py-3 text-neutral-400">{s.normal}</td>
                    <td className="px-3.5 py-3 text-neutral-400">{s.sent}</td>
                    <td className="px-3.5 py-3 text-neutral-400">{s.wechat}</td>
                    <td className="px-3.5 py-3 text-emerald-400 font-semibold">{s.convRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* h-index distribution */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
            <p className="text-[13px] font-semibold mb-4">h-index Distribution</p>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={analytics.channels.hIndexDist}>
                <XAxis dataKey="min" stroke="#525252" tick={{ fontSize: 10 }} />
                <YAxis stroke="#525252" tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ backgroundColor: "#171717", border: "1px solid #333", borderRadius: "8px", fontSize: "12px" }} />
                <Bar dataKey="count" fill="rgba(59,130,246,0.4)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {activeTab === "channels" && !analytics && (
        <div className="text-center py-16 text-neutral-500 animate-pulse">Loading analytics...</div>
      )}

      {/* ═══════════════ SALES TAB ═══════════════ */}
      {activeTab === "sales" && analytics && (
        <div className="space-y-4">
          {/* Rep cards */}
          <div className="grid grid-cols-3 gap-3">
            {analytics.sales.reps.map((r) => (
              <div key={r.rep.id} className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <p className="text-base font-semibold tracking-tight">{r.rep.name}</p>
                    <p className="text-[11px] text-neutral-500 mt-0.5">{r.rep.sender_email}</p>
                  </div>
                  <span className="text-[11px] text-neutral-600 bg-white/[0.04] rounded px-2 py-0.5">{r.rep.wechat_id}</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[11px] text-neutral-500 mb-0.5">Assigned</p>
                    <p className="text-xl font-bold tracking-tight">{r.assigned}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-500 mb-0.5">Sent</p>
                    <p className="text-xl font-bold tracking-tight">{r.sent}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-500 mb-0.5">Replied</p>
                    <p className="text-xl font-bold tracking-tight">{r.replied}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-500 mb-0.5">WeChat Conv.</p>
                    <p className="text-xl font-bold tracking-tight text-emerald-400">{r.convRate}%</p>
                    <div className="w-full h-1 bg-white/[0.06] rounded mt-1.5 overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded" style={{ width: `${Math.min(r.convRate * 5, 100)}%` }} />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Performance matrix */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 overflow-hidden">
            <p className="text-[13px] font-semibold p-5 pb-3 border-b border-neutral-800">Rep × Lead Type Performance</p>
            <table className="w-full text-[13px]">
              <thead>
                <tr>
                  {["Rep", "Tier", "Assigned", "Sent", "Replied", "WeChat", "Conv %"].map((h) => (
                    <th key={h} className="text-left px-3.5 py-2.5 text-[11px] font-semibold text-neutral-500 uppercase tracking-wider border-b border-neutral-800">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {analytics.sales.reps.flatMap((r) =>
                  r.tiers.filter((t) => t.assigned > 0).map((t) => (
                    <tr key={`${r.rep.id}-${t.tier}`} className="border-t border-neutral-800/50 hover:bg-white/[0.02]">
                      <td className="px-3.5 py-3 font-medium text-white">{r.rep.name}</td>
                      <td className="px-3.5 py-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-px text-[10px] font-semibold uppercase tracking-wide ${tierBadgeClass(t.tier)}`}>
                          {t.tier}
                        </span>
                      </td>
                      <td className="px-3.5 py-3 text-neutral-400">{t.assigned}</td>
                      <td className="px-3.5 py-3 text-neutral-400">{t.sent}</td>
                      <td className="px-3.5 py-3 text-neutral-400">{t.replied}</td>
                      <td className="px-3.5 py-3 text-neutral-400">{t.wechat}</td>
                      <td className="px-3.5 py-3 text-emerald-400 font-semibold">{t.convRate}%</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "sales" && !analytics && (
        <div className="text-center py-16 text-neutral-500 animate-pulse">Loading analytics...</div>
      )}
    </div>
  );
}

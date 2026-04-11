"use client";

// Email draft previews are sanitized via sanitizeHtml() which uses DOMPurify

import { useEffect, useState } from "react";
import {
  Zap,
  Send,
  ExternalLink,
  Clock,
  Loader2,
  ChevronDown,
  ChevronUp,
  Pencil,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { sanitizeHtml } from "@/lib/sanitize";

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
  source: string;
  createdAt: string;
  sentAt: string | null;
  // New fields
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

function tierBadgeColor(tier: string | null) {
  return tier === "strong"
    ? "bg-orange-500/20 text-orange-400"
    : "bg-neutral-500/15 text-neutral-500";
}

const STATUS_TABS = ["all", "ready", "new", "sent", "skipped"];

function computeBadgeColor(level: string | null) {
  switch (level) {
    case "heavy": return "bg-red-500/20 text-red-400";
    case "moderate": return "bg-yellow-500/20 text-yellow-400";
    case "light": return "bg-green-500/20 text-green-400";
    default: return "bg-neutral-500/20 text-neutral-400";
  }
}

function statusBadgeColor(status: string) {
  switch (status) {
    case "ready": return "bg-blue-500/20 text-blue-400";
    case "sent": return "bg-green-500/20 text-green-400";
    case "skipped": return "bg-neutral-500/20 text-neutral-400";
    case "replied": return "bg-purple-500/20 text-purple-400";
    default: return "bg-yellow-500/20 text-yellow-400";
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

export default function PipelinePage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editHtml, setEditHtml] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchSending, setBatchSending] = useState(false);
  const [activeTab, setActiveTab] = useState<"leads" | "channels" | "sales">("leads");
  const [tierFilter, setTierFilter] = useState<string>("all");
  const [repFilter, setRepFilter] = useState<string>("all");
  const [reps, setReps] = useState<Rep[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  const fetchLeads = () => {
    setLoading(true);
    const params = new URLSearchParams({ limit: "50" });
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
  };

  useEffect(() => {
    fetchLeads();
  }, [statusFilter, tierFilter, repFilter]);

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
      if (res.ok) {
        fetchLeads();
      } else {
        alert(`Send failed: ${data.error}`);
      }
    } catch {
      alert("Send failed");
    } finally {
      setSending(null);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllReady = () => {
    const readyIds = leads.filter((l) => canSend(l).ok).map((l) => l.id);
    setSelected(new Set(readyIds));
  };

  const handleBatchSend = async () => {
    if (selected.size === 0) return;
    setBatchSending(true);
    try {
      const res = await fetch("/api/pipeline/batch-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const data = await res.json();
      if (res.ok) {
        alert(`Sent ${data.sent}, skipped ${data.skipped}`);
        setSelected(new Set());
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

  const readyCount = leads.filter((l) => l.status === "ready").length;

  return (
    <div>
      {/* ── Page Header ── */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-[22px] font-semibold text-white tracking-tight">Pipeline</h1>
          <p className="text-[13px] text-neutral-500 mt-0.5">
            {total} leads{readyCount > 0 && ` · ${readyCount} ready to send`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {scanResult && (
            <span className={`text-[12px] mr-2 ${scanResult.startsWith("Error") ? "text-red-400" : "text-emerald-400"}`}>
              {scanResult}
            </span>
          )}
          {selected.size > 0 && (
            <>
              <span className="text-[12px] text-neutral-500">{selected.size} selected</span>
              <button
                onClick={handleBatchSend}
                disabled={batchSending}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
              >
                {batchSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                {batchSending ? "Sending..." : `Send ${selected.size}`}
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="text-[12px] text-neutral-500 hover:text-white transition-colors px-2"
              >
                Clear
              </button>
            </>
          )}
          {selected.size === 0 && readyCount > 0 && (
            <button
              onClick={selectAllReady}
              className="rounded-lg border border-neutral-800 px-3 py-1.5 text-[12px] text-neutral-500 hover:text-white hover:border-neutral-600 transition-colors"
            >
              Select All Ready
            </button>
          )}
          <button
            onClick={handleScan}
            disabled={scanning}
            className="flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-1.5 text-[13px] font-medium text-black hover:bg-neutral-200 disabled:opacity-50 transition-colors"
          >
            {scanning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5" />
            )}
            {scanning ? "Scanning..." : "Scan Now"}
          </button>
        </div>
      </div>

      {/* ── Page Tabs ── */}
      <div className="flex gap-0 mb-6 border-b border-white/[0.06]">
        {(["leads", "channels", "sales"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-5 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab
                ? "border-white text-white"
                : "border-transparent text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {tab === "leads" ? `Leads` : tab.charAt(0).toUpperCase() + tab.slice(1)}
            {tab === "leads" && <span className="ml-1.5 text-[11px] text-neutral-600">{total}</span>}
          </button>
        ))}
      </div>

      {/* ═══ LEADS TAB ═══ */}
      {activeTab === "leads" && (
      <>

      {/* Status + filter bar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="flex gap-1">
          {STATUS_TABS.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
                statusFilter === s
                  ? "bg-neutral-800 text-white"
                  : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/50"
              }`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <select
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value)}
          className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-[12px] text-neutral-400"
        >
          <option value="all">All Tiers</option>
          <option value="strong">Strong</option>
          <option value="normal">Normal</option>
        </select>
        <select
          value={repFilter}
          onChange={(e) => setRepFilter(e.target.value)}
          className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-[12px] text-neutral-400"
        >
          <option value="all">All Reps</option>
          {reps.map((r) => (
            <option key={r.id} value={String(r.id)}>{r.name}</option>
          ))}
        </select>
      </div>

      {/* Lead List */}
      {loading ? (
        <div className="text-center text-sm text-neutral-500 animate-pulse py-12">Loading...</div>
      ) : leads.length === 0 ? (
        <div className="text-center py-12">
          <Zap className="h-8 w-8 mx-auto mb-3 text-neutral-600" />
          <p className="text-sm text-neutral-500">
            {statusFilter === "all"
              ? "No leads yet. Click \"Scan Now\" to find papers."
              : `No ${statusFilter} leads.`}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {leads.map((lead) => {
            const sendCheck = canSend(lead);
            const isExpanded = expanded === lead.id;
            const isEditing = editing === lead.id;
            const directions = lead.matchedDirections?.split(",").filter(Boolean) || [];
            const sanitized = lead.draftHtml ? sanitizeHtml(lead.draftHtml) : "";

            return (
              <div
                key={lead.id}
                className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden"
              >
                {/* Lead Header */}
                <div
                  className="px-5 py-4 cursor-pointer hover:bg-neutral-800/20 transition-colors"
                  onClick={() => setExpanded(isExpanded ? null : lead.id)}
                >
                  <div className="flex items-start justify-between gap-4">
                    {lead.status === "ready" && sendCheck.ok && (
                      <input
                        type="checkbox"
                        checked={selected.has(lead.id)}
                        onChange={(e) => { e.stopPropagation(); toggleSelect(lead.id); }}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-1 h-4 w-4 rounded border-neutral-600 bg-neutral-800 flex-shrink-0 accent-blue-500"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusBadgeColor(lead.status)}`}>
                          {lead.status}
                        </span>
                        {lead.leadTier && (
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${tierBadgeColor(lead.leadTier)}`}>
                            {lead.leadTier}
                          </span>
                        )}
                        {lead.computeLevel && (
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${computeBadgeColor(lead.computeLevel)}`}>
                            {lead.computeLevel}
                          </span>
                        )}
                        {lead.schoolName && (
                          <span className="text-[11px] text-neutral-500">{lead.schoolName}</span>
                        )}
                        {lead.hIndex !== null && (
                          <span className="text-[10px] text-neutral-600 bg-white/[0.04] rounded px-1.5 py-0.5">
                            h:{lead.hIndex}
                          </span>
                        )}
                        {lead.citationCount !== null && lead.citationCount > 0 && (
                          <span className="text-[10px] text-neutral-600 bg-white/[0.04] rounded px-1.5 py-0.5">
                            cit:{lead.citationCount.toLocaleString()}
                          </span>
                        )}
                        {!sendCheck.ok && sendCheck.availableIn && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
                            <Clock className="h-3 w-3" />
                            {sendCheck.availableIn}
                          </span>
                        )}
                      </div>
                      <h3 className="text-[14px] font-medium text-white truncate">{lead.title}</h3>
                      <div className="flex items-center gap-3 mt-1 text-[12px] text-neutral-400">
                        <span>{lead.authorName || "Unknown"} &lt;{lead.authorEmail}&gt;</span>
                        <span>{formatDate(lead.createdAt)}</span>
                      </div>
                      {directions.length > 0 && (
                        <div className="flex gap-1 mt-1.5 flex-wrap">
                          {directions.map((d) => (
                            <span key={d} className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                              {d}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      {reps.length > 0 && (
                        <select
                          value={lead.assignedRepId ?? ""}
                          onChange={(e) => {
                            e.stopPropagation();
                            handleRepChange(lead.id, parseInt(e.target.value));
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-1 text-[11px] text-neutral-400"
                        >
                          {reps.map((r) => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                      )}
                      {lead.status === "ready" && (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleSkip(lead.id); }}
                            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[12px] text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                          >
                            Skip
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleSend(lead); }}
                            disabled={!sendCheck.ok || sending === lead.id}
                            className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[12px] font-medium text-black hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            {sending === lead.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Send className="h-3 w-3" />
                            )}
                            Send
                          </button>
                        </>
                      )}
                      {isExpanded ? (
                        <ChevronUp className="h-4 w-4 text-neutral-500" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-neutral-500" />
                      )}
                    </div>
                  </div>
                </div>

                {/* Expanded Detail */}
                {isExpanded && (
                  <div className="border-t border-neutral-800">
                    {lead.abstract && (
                      <div className="px-5 py-3 border-b border-neutral-800/50">
                        <p className="text-[11px] font-medium text-neutral-500 mb-1">ABSTRACT</p>
                        <p className="text-[12px] text-neutral-400 leading-relaxed">
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
                            View on arxiv
                          </a>
                        )}
                      </div>
                    )}

                    {lead.computeReason && (
                      <div className="px-5 py-3 border-b border-neutral-800/50">
                        <p className="text-[11px] font-medium text-neutral-500 mb-1">WHY COMPUTE</p>
                        <p className="text-[12px] text-neutral-400">{lead.computeReason}</p>
                      </div>
                    )}

                    <div className="px-5 py-4">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[11px] font-medium text-neutral-500">EMAIL DRAFT</p>
                        {lead.status === "ready" && !isEditing && (
                          <button
                            onClick={() => startEdit(lead)}
                            className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-white transition-colors"
                          >
                            <Pencil className="h-3 w-3" />
                            Edit
                          </button>
                        )}
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
                            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[12px] text-white font-mono focus:border-neutral-500 focus:outline-none resize-none"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleSaveEdit(lead.id)}
                              className="rounded-lg bg-white px-3 py-1.5 text-[12px] font-medium text-black hover:bg-neutral-200 transition-colors"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditing(null)}
                              className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[12px] text-neutral-400 hover:text-white transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : sanitized ? (
                        <>
                          <p className="text-[12px] text-neutral-300 mb-2">
                            Subject: {lead.draftSubject}
                          </p>
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
                        <p className="text-[12px] text-neutral-500 italic">No draft generated yet</p>
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

      {/* ═══ CHANNELS TAB ═══ */}
      {activeTab === "channels" && analytics && (
        <div className="space-y-6">
          {/* Stat cards */}
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: "Total Leads", value: analytics.channels.totalLeads, sub: `+${analytics.channels.leadsThisWeek} this week` },
              { label: "Strong Leads", value: analytics.channels.strongLeads, sub: `${analytics.channels.totalLeads > 0 ? ((analytics.channels.strongLeads / analytics.channels.totalLeads) * 100).toFixed(1) : 0}% of total` },
              { label: "Avg h-index", value: analytics.channels.avgHIndex, sub: null },
              { label: "Send → WeChat", value: `${analytics.channels.conversionRate}%`, sub: null, highlight: true },
            ].map((card) => (
              <div key={card.label} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
                <p className="text-[12px] text-neutral-500 mb-1">{card.label}</p>
                <p className={`text-[28px] font-bold tracking-tight ${card.highlight ? "text-emerald-400" : "text-white"}`}>
                  {card.value}
                </p>
                {card.sub && <p className="text-[11px] text-emerald-400 mt-1">{card.sub}</p>}
              </div>
            ))}
          </div>

          {/* Daily chart */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
            <p className="text-[13px] font-semibold mb-4">Leads Discovered (Last 30 Days)</p>
            <div className="flex items-end gap-1 h-[160px]">
              {analytics.channels.daily.map((d) => {
                const maxVal = Math.max(...analytics.channels.daily.map((x) => x.strong + x.normal), 1);
                const totalH = ((d.strong + d.normal) / maxVal) * 140;
                const strongH = d.strong > 0 ? (d.strong / (d.strong + d.normal)) * totalH : 0;
                return (
                  <div key={d.date} className="flex-1 flex flex-col items-center justify-end gap-0.5" title={`${d.date}: ${d.strong} strong, ${d.normal} normal`}>
                    <div className="w-full rounded-t" style={{ height: `${totalH - strongH}px`, background: "rgba(59,130,246,0.4)" }} />
                    {strongH > 0 && <div className="w-full rounded-t" style={{ height: `${strongH}px`, background: "rgba(249,115,22,0.7)" }} />}
                  </div>
                );
              })}
            </div>
            <div className="flex gap-4 mt-3 justify-center">
              <span className="flex items-center gap-1.5 text-[11px] text-neutral-500"><span className="w-2 h-2 rounded-sm bg-orange-500/70" /> Strong</span>
              <span className="flex items-center gap-1.5 text-[11px] text-neutral-500"><span className="w-2 h-2 rounded-sm bg-blue-500/40" /> Normal</span>
            </div>
          </div>

          {/* Source table */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
            <p className="text-[13px] font-semibold p-5 pb-3">Source Breakdown</p>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-t border-white/[0.06]">
                  {["Source", "Total", "Strong", "Normal", "Sent", "WeChat", "Conv %"].map((h) => (
                    <th key={h} className="text-left px-5 py-2.5 text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {analytics.channels.sources.map((s: { source: string; total: number; strong: number; normal: number; sent: number; wechat: number; convRate: number }) => (
                  <tr key={s.source} className="border-t border-white/[0.04]">
                    <td className="px-5 py-3 font-medium">{s.source}</td>
                    <td className="px-5 py-3 text-neutral-400">{s.total}</td>
                    <td className="px-5 py-3 text-neutral-400">{s.strong}</td>
                    <td className="px-5 py-3 text-neutral-400">{s.normal}</td>
                    <td className="px-5 py-3 text-neutral-400">{s.sent}</td>
                    <td className="px-5 py-3 text-neutral-400">{s.wechat}</td>
                    <td className="px-5 py-3 text-emerald-400 font-semibold">{s.convRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* h-index distribution */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
            <p className="text-[13px] font-semibold mb-4">h-index Distribution</p>
            <div className="flex items-end gap-1 h-[120px]">
              {analytics.channels.hIndexDist.map((b) => {
                const maxCount = Math.max(...analytics.channels.hIndexDist.map((x) => x.count), 1);
                const h = (b.count / maxCount) * 100;
                return (
                  <div key={b.min} className="flex-1" title={`h ${b.min}-${b.max ?? "+"}: ${b.count}`}>
                    <div className="w-full rounded-t bg-blue-500/30 hover:bg-blue-500/50 transition-colors" style={{ height: `${Math.max(h, 2)}px` }} />
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between mt-2 text-[10px] text-neutral-600">
              <span>0</span><span>10</span><span>20</span><span>30</span><span>40+</span>
            </div>
          </div>
        </div>
      )}

      {activeTab === "channels" && !analytics && (
        <div className="text-center py-12 text-neutral-500 animate-pulse">Loading analytics...</div>
      )}

      {/* ═══ SALES TAB ═══ */}
      {activeTab === "sales" && analytics && (
        <div className="space-y-6">
          {/* Rep cards */}
          <div className="grid grid-cols-3 gap-4">
            {analytics.sales.reps.map((r) => (
              <div key={r.rep.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <p className="text-[16px] font-semibold">{r.rep.name}</p>
                    <p className="text-[11px] text-neutral-500 mt-0.5">{r.rep.sender_email}</p>
                  </div>
                  <span className="text-[11px] text-neutral-600 bg-white/[0.04] rounded px-2 py-0.5">{r.rep.wechat_id}</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[11px] text-neutral-500">Assigned</p>
                    <p className="text-[20px] font-bold">{r.assigned}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-500">Sent</p>
                    <p className="text-[20px] font-bold">{r.sent}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-500">Replied</p>
                    <p className="text-[20px] font-bold">{r.replied}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-500">WeChat Conv.</p>
                    <p className="text-[20px] font-bold text-emerald-400">{r.convRate}%</p>
                    <div className="w-full h-1 bg-white/[0.06] rounded mt-1">
                      <div className="h-full bg-emerald-500 rounded" style={{ width: `${Math.min(r.convRate * 5, 100)}%` }} />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Performance matrix */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
            <p className="text-[13px] font-semibold p-5 pb-3">Rep &times; Lead Type Performance</p>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-t border-white/[0.06]">
                  {["Rep", "Tier", "Assigned", "Sent", "Replied", "WeChat", "Conv %"].map((h) => (
                    <th key={h} className="text-left px-5 py-2.5 text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {analytics.sales.reps.flatMap((r) =>
                  r.tiers.filter((t) => t.assigned > 0).map((t) => (
                    <tr key={`${r.rep.id}-${t.tier}`} className="border-t border-white/[0.04]">
                      <td className="px-5 py-3 font-medium">{r.rep.name}</td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${tierBadgeColor(t.tier)}`}>
                          {t.tier}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-neutral-400">{t.assigned}</td>
                      <td className="px-5 py-3 text-neutral-400">{t.sent}</td>
                      <td className="px-5 py-3 text-neutral-400">{t.replied}</td>
                      <td className="px-5 py-3 text-neutral-400">{t.wechat}</td>
                      <td className="px-5 py-3 text-emerald-400 font-semibold">{t.convRate}%</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "sales" && !analytics && (
        <div className="text-center py-12 text-neutral-500 animate-pulse">Loading analytics...</div>
      )}
    </div>
  );
}

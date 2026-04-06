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

  const fetchLeads = () => {
    setLoading(true);
    const params = new URLSearchParams({ limit: "50" });
    if (statusFilter !== "all") params.set("status", statusFilter);

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
  }, [statusFilter]);

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
    <div className="p-8 max-w-[1200px]">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Pipeline</h1>
          <p className="text-sm text-neutral-400 mt-1">
            {total} leads{readyCount > 0 && ` · ${readyCount} ready to send`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {scanResult && (
            <span className={`text-[12px] ${scanResult.startsWith("Error") ? "text-red-400" : "text-green-400"}`}>
              {scanResult}
            </span>
          )}
          {selected.size > 0 && (
            <>
              <span className="text-[12px] text-neutral-400">{selected.size} selected</span>
              <button
                onClick={handleBatchSend}
                disabled={batchSending}
                className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
              >
                {batchSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {batchSending ? "Sending..." : `Send ${selected.size}`}
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="text-[12px] text-neutral-400 hover:text-white transition-colors"
              >
                Clear
              </button>
            </>
          )}
          {selected.size === 0 && readyCount > 0 && (
            <button
              onClick={selectAllReady}
              className="rounded-lg border border-neutral-700 px-3 py-2 text-[12px] text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
            >
              Select All Ready
            </button>
          )}
          <button
            onClick={handleScan}
            disabled={scanning}
            className="flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-[13px] font-medium text-black hover:bg-neutral-200 disabled:opacity-50 transition-colors"
          >
            {scanning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
            {scanning ? "Scanning..." : "Scan Now"}
          </button>
        </div>
      </div>

      {/* Status Tabs */}
      <div className="flex gap-1 mb-6 border-b border-neutral-800 pb-3">
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
                className="rounded-xl border border-neutral-800 bg-neutral-900/50 overflow-hidden"
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
                        {lead.computeLevel && (
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${computeBadgeColor(lead.computeLevel)}`}>
                            {lead.computeLevel}
                          </span>
                        )}
                        {lead.schoolName && (
                          <span className="text-[11px] text-neutral-500">{lead.schoolName}</span>
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
    </div>
  );
}

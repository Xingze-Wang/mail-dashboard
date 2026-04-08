"use client";

import { useEffect, useState } from "react";
import {
  Plus,
  RefreshCw,
  ArrowLeft,
  Loader2,
  FileText,
  GraduationCap,
  Cpu,
  ExternalLink,
  Search,
} from "lucide-react";
import { formatDate, getStatusColor, getStatusDot } from "@/lib/utils";
import { ComposeModal } from "@/components/compose-modal";
import { sanitizeHtml } from "@/lib/sanitize";

interface Email {
  id: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string | null;
  status: string;
  createdAt: string;
  resendId: string | null;
}

interface BriefData {
  id: string;
  personName: string;
  firstName: string | null;
  paper: {
    title: string;
    arxivId: string;
    pdfUrl: string | null;
    abstract: string | null;
    authors: string | null;
    publishedAt: string | null;
  };
  research: {
    computeLevel: string | null;
    computeConfidence: number | null;
    computeReason: string | null;
    directions: string[];
    schoolName: string | null;
    schoolTier: number | null;
  };
  outreach: {
    emailedTo: string;
    emailedName: string | null;
    status: string;
    sentAt: string | null;
  };
  authorMismatch: { note: string } | null;
}

function computeBadge(level: string | null) {
  switch (level) {
    case "heavy": return "bg-red-500/20 text-red-400";
    case "moderate": return "bg-yellow-500/20 text-yellow-400";
    case "light": return "bg-green-500/20 text-green-400";
    default: return "bg-neutral-500/20 text-neutral-400";
  }
}

function BriefPanel({ email }: { email: Email }) {
  const [brief, setBrief] = useState<BriefData | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setLoading(true);
    setBrief(null);
    setSummary(null);
    setExpanded(false);

    fetch(`/api/brief?email=${encodeURIComponent(email.to)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.briefs && data.briefs.length > 0) {
          setBrief(data.briefs[0]);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [email.to]);

  // Fetch AI summary when expanded
  useEffect(() => {
    if (!expanded || !brief || summary) return;
    setSummaryLoading(true);
    fetch(`/api/brief/summary?id=${encodeURIComponent(brief.id)}`)
      .then((r) => r.json())
      .then((d) => setSummary(d.summary ?? null))
      .catch(() => {})
      .finally(() => setSummaryLoading(false));
  }, [expanded, brief, summary]);

  if (loading) {
    return (
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 mt-4 animate-pulse">
        <div className="flex items-center gap-2 text-[12px] text-neutral-600">
          <Search className="h-3.5 w-3.5" />
          Looking up paper...
        </div>
      </div>
    );
  }

  if (!brief) return null;

  const { paper, research } = brief;

  return (
    <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 mt-4">
      {/* Collapsed: one-line summary */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-5 py-3 flex items-center justify-between gap-3"
      >
        <div className="flex items-center gap-3 min-w-0">
          <FileText className="h-4 w-4 text-blue-400 shrink-0" />
          <div className="min-w-0">
            <span className="text-[13px] text-blue-300 font-medium truncate block">
              {paper.title}
            </span>
            <div className="flex items-center gap-2 mt-0.5 text-[11px] text-neutral-500">
              {brief.personName && <span>{brief.personName}</span>}
              {research.schoolName && (
                <>
                  <span className="text-neutral-700">·</span>
                  <span>{research.schoolName}</span>
                </>
              )}
              {research.computeLevel && (
                <>
                  <span className="text-neutral-700">·</span>
                  <span className={`rounded px-1 py-0.5 text-[10px] ${computeBadge(research.computeLevel)}`}>
                    {research.computeLevel}
                  </span>
                </>
              )}
              {research.directions.length > 0 && (
                <>
                  <span className="text-neutral-700">·</span>
                  <span>{research.directions.slice(0, 2).join(", ")}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <span className="text-[11px] text-neutral-600 shrink-0">
          {expanded ? "Collapse" : "View brief"}
        </span>
      </button>

      {/* Expanded: full brief */}
      {expanded && (
        <div className="px-5 pb-4 space-y-4 border-t border-blue-500/10 pt-4">
          {/* AI Summary */}
          <div>
            <p className="text-[11px] text-blue-400 font-medium mb-1.5">Sales Brief</p>
            {summaryLoading ? (
              <p className="text-[12px] text-neutral-500 animate-pulse">Generating brief...</p>
            ) : summary ? (
              <p className="text-[13px] text-neutral-200 leading-relaxed whitespace-pre-line">
                {summary}
              </p>
            ) : (
              <p className="text-[12px] text-neutral-500">No summary available</p>
            )}
          </div>

          {/* Paper details */}
          <div>
            <p className="text-[11px] text-neutral-500 font-medium mb-1">Paper</p>
            <p className="text-[12px] text-neutral-300 mb-1">{paper.authors}</p>
            {paper.abstract && (
              <p className="text-[11px] text-neutral-500 leading-relaxed">
                {paper.abstract.length > 400
                  ? paper.abstract.slice(0, 400) + "..."
                  : paper.abstract}
              </p>
            )}
            {paper.pdfUrl && (
              <a
                href={paper.pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-2 text-[11px] text-blue-400 hover:text-blue-300"
              >
                <ExternalLink className="h-3 w-3" />
                PDF
              </a>
            )}
          </div>

          {/* Compute + directions */}
          {research.computeReason && (
            <div>
              <p className="text-[11px] text-neutral-500 font-medium mb-1">
                Compute ({research.computeLevel})
              </p>
              <p className="text-[12px] text-neutral-400">{research.computeReason}</p>
            </div>
          )}

          {/* Author mismatch */}
          {brief.authorMismatch && (
            <div className="rounded bg-amber-500/10 border border-amber-500/20 px-3 py-2">
              <p className="text-[11px] text-amber-400">{brief.authorMismatch.note}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function EmailsPage() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [selected, setSelected] = useState<Email | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchEmails = () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "50" });
    if (statusFilter) params.set("status", statusFilter);

    fetch(`/api/emails?${params}`)
      .then((res) => res.json())
      .then((data) => {
        setEmails(data.emails);
        setTotal(data.total);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  const openEmail = async (email: Email) => {
    setSelected(email);
    // If no content, fetch full email from Resend
    if (!email.html || email.html === "") {
      setDetailLoading(true);
      try {
        const res = await fetch(`/api/emails/${email.id}`);
        const full = await res.json();
        if (full.html || full.text) {
          setSelected(full);
        }
      } catch {
        // Keep showing what we have
      } finally {
        setDetailLoading(false);
      }
    }
  };

  useEffect(() => {
    fetchEmails();
  }, [page, statusFilter]);

  const statuses = ["all", "sent", "delivered", "clicked", "bounced", "complained"];

  // Detail view
  if (selected) {
    // Note: sanitizeHtml uses DOMPurify for XSS protection
    const sanitized = selected.html ? sanitizeHtml(selected.html) : "";

    return (
      <div className="p-8 max-w-[1200px]">
        <button
          onClick={() => setSelected(null)}
          className="flex items-center gap-2 text-[13px] text-neutral-400 hover:text-white mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to emails
        </button>

        <div className="rounded-xl border border-neutral-800 bg-neutral-900/50">
          <div className="px-6 py-5 border-b border-neutral-800">
            <h2 className="text-[18px] font-semibold text-white mb-3">{selected.subject}</h2>
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
              <span className="text-neutral-500">From</span>
              <span className="text-neutral-300">{selected.from}</span>
              <span className="text-neutral-500">To</span>
              <span className="text-neutral-300">{selected.to}</span>
              <span className="text-neutral-500">Status</span>
              <div className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-full ${getStatusDot(selected.status)}`} />
                <span className={`font-medium capitalize ${getStatusColor(selected.status)}`}>
                  {selected.status}
                </span>
              </div>
              <span className="text-neutral-500">Date</span>
              <span className="text-neutral-300">{new Date(selected.createdAt).toLocaleString()}</span>
              {selected.resendId && (
                <>
                  <span className="text-neutral-500">ID</span>
                  <span className="text-neutral-500 font-mono text-[11px]">{selected.resendId}</span>
                </>
              )}
            </div>
          </div>

          {/* Paper brief — auto-matches by recipient email */}
          <div className="px-6 pt-2">
            <BriefPanel email={selected} />
          </div>

          <div className="p-6">
            {detailLoading ? (
              <div className="flex items-center gap-2 text-neutral-500 text-[13px]">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading email content...
              </div>
            ) : sanitized ? (
              <>
                <div
                  className="email-detail-content rounded-lg bg-white text-black p-5"
                  dangerouslySetInnerHTML={{ __html: sanitized }}
                />
                <style>{`
                  .email-detail-content, .email-detail-content * { color: #1a1a1a !important; }
                  .email-detail-content a { color: #2563eb !important; }
                  .email-detail-content img { max-width: 100%; height: auto; }
                `}</style>
              </>
            ) : selected.text ? (
              <pre className="text-[13px] text-neutral-300 whitespace-pre-wrap font-sans">
                {selected.text}
              </pre>
            ) : (
              <p className="text-[13px] text-neutral-500 italic">
                Content not available — this email may have expired from Resend&apos;s storage.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // List view
  return (
    <div className="p-8 max-w-[1200px]">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Emails</h1>
          <p className="text-sm text-neutral-400 mt-1">{total} total emails</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={fetchEmails}
            className="rounded-lg border border-neutral-700 p-2 text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            onClick={() => setComposeOpen(true)}
            className="flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-[13px] font-medium text-black hover:bg-neutral-200 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Compose
          </button>
        </div>
      </div>

      {/* Status Filter */}
      <div className="flex gap-1 mb-6 border-b border-neutral-800 pb-3">
        {statuses.map((s) => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s === "all" ? null : s); setPage(1); }}
            className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
              (s === "all" && !statusFilter) || s === statusFilter
                ? "bg-neutral-800 text-white"
                : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/50"
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Email List */}
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 overflow-hidden">
        <div className="grid grid-cols-[1fr_200px_100px_120px] gap-4 px-5 py-3 border-b border-neutral-800 bg-neutral-900/80">
          <span className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider">To / Subject</span>
          <span className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider">From</span>
          <span className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Status</span>
          <span className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider text-right">Date</span>
        </div>

        {loading ? (
          <div className="px-5 py-8 text-center text-sm text-neutral-500 animate-pulse">Loading...</div>
        ) : emails.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-neutral-500">No emails found.</div>
        ) : (
          <div className="divide-y divide-neutral-800/50">
            {emails.map((email) => (
              <div
                key={email.id}
                onClick={() => openEmail(email)}
                className="grid grid-cols-[1fr_200px_100px_120px] gap-4 px-5 py-3 hover:bg-neutral-800/30 transition-colors cursor-pointer"
              >
                <div className="min-w-0">
                  <p className="text-[13px] text-white truncate">{email.to}</p>
                  <p className="text-[12px] text-neutral-500 truncate">{email.subject}</p>
                </div>
                <div className="flex items-center">
                  <span className="text-[12px] text-neutral-400 truncate">{email.from}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${getStatusDot(email.status)}`} />
                  <span className={`text-[12px] font-medium capitalize ${getStatusColor(email.status)}`}>
                    {email.status}
                  </span>
                </div>
                <div className="flex items-center justify-end">
                  <span className="text-[12px] text-neutral-500">{formatDate(email.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {total > 50 && (
        <div className="flex items-center justify-between mt-4">
          <button
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[12px] text-neutral-400 hover:text-white disabled:opacity-30"
          >
            Previous
          </button>
          <span className="text-[12px] text-neutral-500">Page {page} of {Math.ceil(total / 50)}</span>
          <button
            disabled={page >= Math.ceil(total / 50)}
            onClick={() => setPage(page + 1)}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-[12px] text-neutral-400 hover:text-white disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}

      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} />
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Plus, RefreshCw, ArrowLeft, Loader2 } from "lucide-react";
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

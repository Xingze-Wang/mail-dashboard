"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Reply, Mail, MailOpen, Send } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { sanitizeHtml } from "@/lib/sanitize";

interface InboundEmail {
  id: string;
  from: string;
  to: string;
  subject: string;
  html: string | null;
  text: string | null;
  isRead: boolean;
  createdAt: string;
}

export default function InboxPage() {
  const [emails, setEmails] = useState<InboundEmail[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<InboundEmail | null>(null);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);

  const fetchInbox = () => {
    setLoading(true);
    fetch("/api/inbound")
      .then((res) => res.json())
      .then((data) => {
        setEmails(data.emails);
        setTotal(data.total);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchInbox();
  }, []);

  const handleReply = async () => {
    if (!selected || !replyBody.trim()) return;
    setSending(true);
    setSendResult(null);

    // Build reply HTML with quoted original
    const date = selected.createdAt ? new Date(selected.createdAt).toLocaleString() : "";
    const quotedContent = selected.html || selected.text?.replace(/\n/g, "<br>") || "";
    const htmlContent = `<div style="font-family:sans-serif;font-size:14px;">${replyBody.replace(/\n/g, "<br>")}</div>
<div style="margin-top:16px;padding-top:12px;border-top:1px solid #ccc;color:#666;font-size:13px;">
On ${date}, ${selected.from} wrote:
<blockquote style="margin:8px 0 0 0;padding-left:12px;border-left:3px solid #ccc;color:#888;">${quotedContent}</blockquote>
</div>`;

    try {
      const res = await fetch("/api/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inboundEmailId: selected.id, html: htmlContent }),
      });
      const data = await res.json();
      if (res.ok) {
        setSendResult("Sent!");
        setTimeout(() => {
          setReplyOpen(false);
          setReplyBody("");
          setSendResult(null);
        }, 1500);
      } else {
        setSendResult(`Error: ${data.error}`);
      }
    } catch {
      setSendResult("Failed to send");
    } finally {
      setSending(false);
    }
  };

  // Note: sanitizeHtml uses DOMPurify for safe rendering
  const sanitized = selected?.html ? sanitizeHtml(selected.html) : "";

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Inbox</h1>
          <p className="text-sm text-neutral-400 mt-1">{total} received emails</p>
        </div>
        <button
          onClick={fetchInbox}
          className="rounded-lg border border-neutral-700 p-2 text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      <div className="flex gap-4 h-[calc(100vh-180px)]">
        {/* Email List */}
        <div className="w-[380px] rounded-xl border border-neutral-800 bg-neutral-900/50 overflow-auto flex-shrink-0">
          {loading ? (
            <div className="p-5 text-center text-sm text-neutral-500 animate-pulse">Loading...</div>
          ) : emails.length === 0 ? (
            <div className="p-5 text-center text-sm text-neutral-500">
              <Mail className="h-8 w-8 mx-auto mb-3 text-neutral-600" />
              No inbound emails yet.
            </div>
          ) : (
            <div className="divide-y divide-neutral-800/50">
              {emails.map((email) => (
                <button
                  key={email.id}
                  onClick={() => { setSelected(email); setReplyOpen(false); setReplyBody(""); }}
                  className={`w-full text-left px-4 py-3 hover:bg-neutral-800/30 transition-colors ${
                    selected?.id === email.id ? "bg-neutral-800/50" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    {email.isRead ? (
                      <MailOpen className="h-3.5 w-3.5 text-neutral-500 flex-shrink-0" />
                    ) : (
                      <Mail className="h-3.5 w-3.5 text-blue-400 flex-shrink-0" />
                    )}
                    <span className={`text-[13px] truncate ${email.isRead ? "text-neutral-400" : "text-white font-medium"}`}>
                      {email.from}
                    </span>
                    <span className="text-[11px] text-neutral-500 ml-auto flex-shrink-0">
                      {formatDate(email.createdAt)}
                    </span>
                  </div>
                  <p className={`text-[12px] truncate pl-5 ${email.isRead ? "text-neutral-500" : "text-neutral-300"}`}>
                    {email.subject}
                  </p>
                  {email.text && (
                    <p className="text-[11px] text-neutral-600 truncate pl-5 mt-0.5">
                      {email.text.slice(0, 80)}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Email Detail + Inline Reply */}
        <div className="flex-1 rounded-xl border border-neutral-800 bg-neutral-900/50 overflow-auto flex flex-col">
          {selected ? (
            <>
              {/* Header */}
              <div className="border-b border-neutral-800 px-6 py-4 flex-shrink-0">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-[16px] font-semibold text-white">{selected.subject}</h2>
                  {!replyOpen && (
                    <button
                      onClick={() => setReplyOpen(true)}
                      className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-[12px] font-medium text-black hover:bg-neutral-200 transition-colors"
                    >
                      <Reply className="h-3.5 w-3.5" />
                      Reply
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-4 text-[12px] text-neutral-400">
                  <span>From: <span className="text-neutral-300">{selected.from}</span></span>
                  <span>To: <span className="text-neutral-300">{selected.to}</span></span>
                  <span>{new Date(selected.createdAt).toLocaleString()}</span>
                </div>
              </div>

              {/* Email Body */}
              <div className="p-6 flex-1 overflow-auto">
                {sanitized ? (
                  <div
                    className="email-content rounded-lg bg-white text-black p-5"
                    dangerouslySetInnerHTML={{ __html: sanitized }}
                  />
                ) : (
                  <pre className="text-[13px] text-neutral-300 whitespace-pre-wrap font-sans">
                    {selected.text || "(no content)"}
                  </pre>
                )}
                <style>{`
                  .email-content, .email-content * { color: #1a1a1a !important; }
                  .email-content a { color: #2563eb !important; }
                  .email-content img { max-width: 100%; height: auto; }
                  .email-content blockquote {
                    border-left: 3px solid #d1d5db !important;
                    padding-left: 12px;
                    color: #6b7280 !important;
                  }
                `}</style>
              </div>

              {/* Inline Reply — Gmail style */}
              {replyOpen && (
                <div className="border-t border-neutral-800 px-6 py-4 flex-shrink-0">
                  <div className="rounded-lg border border-neutral-700 bg-neutral-900 p-4">
                    <div className="text-[12px] text-neutral-400 mb-3">
                      Reply to <span className="text-neutral-200">{selected.from}</span>
                    </div>
                    <textarea
                      value={replyBody}
                      onChange={(e) => setReplyBody(e.target.value)}
                      placeholder="Write your reply..."
                      rows={4}
                      autoFocus
                      className="w-full bg-transparent text-[13px] text-white placeholder:text-neutral-600 focus:outline-none resize-none mb-3"
                    />
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleReply}
                          disabled={sending || !replyBody.trim()}
                          className="flex items-center gap-2 rounded-lg bg-white px-4 py-1.5 text-[12px] font-medium text-black hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          <Send className="h-3 w-3" />
                          {sending ? "Sending..." : "Send"}
                        </button>
                        <button
                          onClick={() => { setReplyOpen(false); setReplyBody(""); setSendResult(null); }}
                          className="rounded-lg px-3 py-1.5 text-[12px] text-neutral-400 hover:text-white transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                      {sendResult && (
                        <span className={`text-[12px] ${sendResult.startsWith("Error") ? "text-red-400" : "text-green-400"}`}>
                          {sendResult}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-neutral-500 text-sm">
              Select an email to read
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

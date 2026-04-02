"use client";

import { useEffect, useState } from "react";
import { RefreshCw, Reply, Mail, MailOpen } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { sanitizeHtml } from "@/lib/sanitize";
import { ComposeModal } from "@/components/compose-modal";

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
  const [replyTo, setReplyTo] = useState<{
    inboundEmailId: string;
    from: string;
    subject: string;
  } | null>(null);

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

  return (
    <div className="p-8 max-w-[1200px]">
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
              No inbound emails yet. Configure your Resend webhook to receive emails here.
            </div>
          ) : (
            <div className="divide-y divide-neutral-800/50">
              {emails.map((email) => (
                <button
                  key={email.id}
                  onClick={() => setSelected(email)}
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

        {/* Email Detail */}
        <div className="flex-1 rounded-xl border border-neutral-800 bg-neutral-900/50 overflow-auto">
          {selected ? (
            <div>
              <div className="border-b border-neutral-800 px-6 py-4">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-[16px] font-semibold text-white">{selected.subject}</h2>
                  <button
                    onClick={() =>
                      setReplyTo({
                        inboundEmailId: selected.id,
                        from: selected.from,
                        subject: selected.subject,
                      })
                    }
                    className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-[12px] font-medium text-black hover:bg-neutral-200 transition-colors"
                  >
                    <Reply className="h-3.5 w-3.5" />
                    Reply
                  </button>
                </div>
                <div className="flex items-center gap-4 text-[12px] text-neutral-400">
                  <span>From: <span className="text-neutral-300">{selected.from}</span></span>
                  <span>To: <span className="text-neutral-300">{selected.to}</span></span>
                  <span>{new Date(selected.createdAt).toLocaleString()}</span>
                </div>
              </div>

              <div className="p-6">
                {selected.html ? (
                  <div
                    className="prose prose-invert prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(selected.html) }}
                  />
                ) : (
                  <pre className="text-[13px] text-neutral-300 whitespace-pre-wrap font-sans">
                    {selected.text || "(no content)"}
                  </pre>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-neutral-500 text-sm">
              Select an email to read
            </div>
          )}
        </div>
      </div>

      <ComposeModal
        open={!!replyTo}
        onClose={() => setReplyTo(null)}
        replyTo={replyTo}
      />
    </div>
  );
}

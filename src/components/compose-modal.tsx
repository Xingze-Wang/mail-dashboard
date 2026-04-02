"use client";

import { useState } from "react";
import { X } from "lucide-react";

interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
  replyTo?: {
    inboundEmailId: string;
    from: string;
    subject: string;
  } | null;
}

export function ComposeModal({ open, onClose, replyTo }: ComposeModalProps) {
  const [to, setTo] = useState(replyTo?.from || "");
  const [subject, setSubject] = useState(
    replyTo ? (replyTo.subject.startsWith("Re:") ? replyTo.subject : `Re: ${replyTo.subject}`) : ""
  );
  const [html, setHtml] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (!open) return null;

  const handleSend = async () => {
    setSending(true);
    setResult(null);

    try {
      const endpoint = replyTo ? "/api/reply" : "/api/send";
      const body = replyTo
        ? { inboundEmailId: replyTo.inboundEmailId, html: `<div>${html}</div>` }
        : { to, subject, html: `<div>${html}</div>` };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (res.ok) {
        setResult("Sent!");
        setTimeout(() => {
          onClose();
          setTo("");
          setSubject("");
          setHtml("");
          setResult(null);
        }, 1000);
      } else {
        setResult(`Error: ${data.error}`);
      }
    } catch {
      setResult("Failed to send");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-xl border border-neutral-800 bg-neutral-950 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-4">
          <h2 className="text-[15px] font-semibold text-white">
            {replyTo ? "Reply" : "Compose"}
          </h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-white transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {!replyTo && (
            <>
              <div>
                <label className="block text-[12px] font-medium text-neutral-400 mb-1.5">To</label>
                <input
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="recipient@example.com"
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-[13px] text-white placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-neutral-400 mb-1.5">Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Email subject"
                  className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-[13px] text-white placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
                />
              </div>
            </>
          )}

          {replyTo && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2.5">
              <p className="text-[12px] text-neutral-400">
                Replying to <span className="text-white">{replyTo.from}</span>
              </p>
              <p className="text-[12px] text-neutral-500 mt-0.5">{subject}</p>
            </div>
          )}

          <div>
            <label className="block text-[12px] font-medium text-neutral-400 mb-1.5">Content</label>
            <textarea
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              placeholder="Write your email..."
              rows={8}
              className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-[13px] text-white placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none resize-none"
            />
          </div>

          {result && (
            <p className={`text-[12px] ${result.startsWith("Error") ? "text-red-400" : "text-green-400"}`}>
              {result}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 border-t border-neutral-800 px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-neutral-700 px-4 py-2 text-[13px] font-medium text-neutral-300 hover:bg-neutral-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending || (!replyTo && (!to || !subject)) || !html}
            className="rounded-lg bg-white px-4 py-2 text-[13px] font-medium text-black hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

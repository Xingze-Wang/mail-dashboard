"use client";

import { useState, useEffect } from "react";
import { X } from "lucide-react";

interface ReplyTo {
  inboundEmailId: string;
  from: string;
  subject: string;
  html?: string | null;
  text?: string | null;
  createdAt?: string;
}

interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
  replyTo?: ReplyTo | null;
}

function buildQuotedHtml(reply: ReplyTo): string {
  const date = reply.createdAt
    ? new Date(reply.createdAt).toLocaleString()
    : "";
  const header = `On ${date}, ${reply.from} wrote:`;
  const quotedContent = reply.html || reply.text?.replace(/\n/g, "<br>") || "";

  return `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #ccc;color:#666;font-size:13px;">${header}<blockquote style="margin:8px 0 0 0;padding-left:12px;border-left:3px solid #ccc;color:#888;">${quotedContent}</blockquote></div>`;
}

export function ComposeModal({ open, onClose, replyTo }: ComposeModalProps) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // Reset fields when replyTo changes
  useEffect(() => {
    if (replyTo) {
      setTo(replyTo.from);
      const subj = replyTo.subject;
      setSubject(subj.startsWith("Re:") || subj.startsWith("回复") ? subj : `Re: ${subj}`);
      setBody("");
    } else {
      setTo("");
      setSubject("");
      setBody("");
    }
    setResult(null);
  }, [replyTo]);

  if (!open) return null;

  const handleSend = async () => {
    setSending(true);
    setResult(null);

    try {
      const endpoint = replyTo ? "/api/reply" : "/api/send";

      // For replies, wrap the user's message + quoted original
      let htmlContent = `<div style="font-family:sans-serif;font-size:14px;">${body.replace(/\n/g, "<br>")}</div>`;
      if (replyTo) {
        htmlContent += buildQuotedHtml(replyTo);
      }

      const reqBody = replyTo
        ? { inboundEmailId: replyTo.inboundEmailId, html: htmlContent }
        : { to, subject, html: htmlContent };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });

      const data = await res.json();
      if (res.ok) {
        setResult("Sent!");
        setTimeout(() => {
          onClose();
          setBody("");
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

  // Preview of quoted content for reply
  const quotedPreview = replyTo?.text
    ? replyTo.text.slice(0, 200) + (replyTo.text.length > 200 ? "..." : "")
    : null;

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
                To: <span className="text-white">{replyTo.from}</span>
              </p>
              <p className="text-[12px] text-neutral-500 mt-0.5">{subject}</p>
            </div>
          )}

          <div>
            <label className="block text-[12px] font-medium text-neutral-400 mb-1.5">
              {replyTo ? "Your reply" : "Content"}
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your reply..."
              rows={6}
              autoFocus
              className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-[13px] text-white placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none resize-none"
            />
          </div>

          {/* Quoted original */}
          {quotedPreview && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 px-3 py-2.5 max-h-32 overflow-auto">
              <p className="text-[11px] text-neutral-500 mb-1">
                On {replyTo?.createdAt ? new Date(replyTo.createdAt).toLocaleString() : ""}, {replyTo?.from} wrote:
              </p>
              <p className="text-[12px] text-neutral-500 whitespace-pre-wrap">{quotedPreview}</p>
            </div>
          )}

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
            disabled={sending || (!replyTo && (!to || !subject)) || !body}
            className="rounded-lg bg-white px-4 py-2 text-[13px] font-medium text-black hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

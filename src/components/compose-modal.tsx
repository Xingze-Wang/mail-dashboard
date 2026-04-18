"use client";

import { useState, useEffect, useCallback } from "react";
import { X, Send, Loader2 } from "lucide-react";

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

  // Escape-key dismiss
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, handleKey]);

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
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        style={{ width: "100%", maxWidth: 560 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--border-light)",
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: 16,
              fontWeight: 600,
              color: "var(--text)",
              letterSpacing: "-0.01em",
            }}
          >
            {replyTo ? "Reply" : "Compose"}
          </h2>
          <button
            onClick={onClose}
            className="btn-ghost"
            aria-label="Close"
            style={{ borderRadius: 6 }}
          >
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
          {!replyTo && (
            <>
              <div className="form-section" style={{ marginBottom: 0 }}>
                <label>To</label>
                <input
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="recipient@example.com"
                />
              </div>
              <div className="form-section" style={{ marginBottom: 0 }}>
                <label>Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Email subject"
                />
              </div>
            </>
          )}

          {replyTo && (
            <div
              style={{
                borderRadius: 8,
                border: "1px solid var(--border-light)",
                background: "var(--bg)",
                padding: "10px 14px",
              }}
            >
              <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                To: <span style={{ color: "var(--text)", fontWeight: 500 }}>{replyTo.from}</span>
              </p>
              <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{subject}</p>
            </div>
          )}

          <div className="form-section" style={{ marginBottom: 0 }}>
            <label>{replyTo ? "Your reply" : "Content"}</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message..."
              rows={6}
              autoFocus
              style={{ resize: "none", lineHeight: 1.6 }}
            />
          </div>

          {/* Quoted original */}
          {quotedPreview && (
            <div
              style={{
                borderRadius: 8,
                border: "1px solid var(--border-light)",
                background: "var(--bg)",
                padding: "10px 14px",
                maxHeight: 128,
                overflowY: "auto",
              }}
            >
              <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 4 }}>
                On {replyTo?.createdAt ? new Date(replyTo.createdAt).toLocaleString() : ""}, {replyTo?.from} wrote:
              </p>
              <p style={{ fontSize: 12, color: "var(--text-secondary)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                {quotedPreview}
              </p>
            </div>
          )}

          {result && (
            <p
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: result.startsWith("Error") ? "var(--coral)" : "var(--green)",
              }}
            >
              {result}
            </p>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
            padding: "14px 20px",
            borderTop: "1px solid var(--border-light)",
          }}
        >
          <button onClick={onClose} className="btn">
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sending || (!replyTo && (!to || !subject)) || !body}
            className="btn btn-primary"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send />}
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

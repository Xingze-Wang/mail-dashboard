"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, Reply, Mail, Send, FileText } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { sanitizeHtml } from "@/lib/sanitize";

const DRAFT_KEY_PREFIX = "inbox-reply-draft:";
const draftKey = (id: string) => `${DRAFT_KEY_PREFIX}${id}`;
const hasDraft = (id: string) =>
  typeof window !== "undefined" && !!localStorage.getItem(draftKey(id));

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
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [draftIds, setDraftIds] = useState<Set<string>>(new Set());
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Discover which inbox rows already have saved drafts (for the badge).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const ids = new Set<string>();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(DRAFT_KEY_PREFIX)) {
        ids.add(k.slice(DRAFT_KEY_PREFIX.length));
      }
    }
    setDraftIds(ids);
  }, [emails]);

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

  // While the inbox page is mounted, ask the sidebar to poll faster.
  useEffect(() => {
    window.dispatchEvent(new Event("inbox:fast-poll-on"));
    return () => {
      window.dispatchEvent(new Event("inbox:fast-poll-off"));
    };
  }, []);

  const markRead = (email: InboundEmail) => {
    if (email.isRead) return;
    // Optimistic UI; reconcile via next fetch if it fails.
    setEmails((prev) =>
      prev.map((e) => (e.id === email.id ? { ...e, isRead: true } : e)),
    );
    if (selected?.id === email.id) {
      setSelected({ ...email, isRead: true });
    }
    fetch(`/api/inbound/${email.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isRead: true }),
    })
      .then((r) => {
        if (r.ok) window.dispatchEvent(new Event("inbox:read"));
      })
      .catch(() => { /* keep optimistic */ });
  };

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
        if (selected) {
          localStorage.removeItem(draftKey(selected.id));
          setDraftIds((s) => {
            const next = new Set(s);
            next.delete(selected.id);
            return next;
          });
        }
        setTimeout(() => {
          setReplyOpen(false);
          setReplyBody("");
          setSendResult(null);
          setDraftSavedAt(null);
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

  // sanitizeHtml is DOMPurify-based — safe from XSS
  const sanitized = selected?.html ? sanitizeHtml(selected.html) : "";

  return (
    <div>
      {/* ── Page Header ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 className="page-title">Inbox</h1>
          <span className="lead-count">{total} received</span>
        </div>
        <button onClick={fetchInbox} className="btn">
          <RefreshCw />
          Refresh
        </button>
      </div>

      <div style={{ display: "flex", gap: 16, height: "calc(100vh - 180px)" }}>
        {/* ── Email List ── */}
        <div
          style={{
            width: 380,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-sm)",
            overflow: "auto",
            flexShrink: 0,
          }}
        >
          {loading ? (
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="skeleton" style={{ height: 56 }} />
              ))}
            </div>
          ) : emails.length === 0 ? (
            <div className="empty-state" style={{ padding: "48px 20px", border: "none" }}>
              <div className="empty-icon">
                <Mail style={{ width: 20, height: 20 }} />
              </div>
              <h3>No inbound mail</h3>
              <p>Replies and inbound emails will appear here.</p>
            </div>
          ) : (
            <div>
              {emails.map((email) => {
                const isSelected = selected?.id === email.id;
                const initials = email.from
                  .replace(/<.*>/g, "")
                  .trim()
                  .split(/[\s@]+/)
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((s) => s[0]?.toUpperCase() ?? "")
                  .join("") || "?";
                return (
                  <button
                    key={email.id}
                    onClick={() => {
                      setSelected(email);
                      const saved = localStorage.getItem(draftKey(email.id)) ?? "";
                      setReplyBody(saved);
                      setReplyOpen(saved.length > 0);
                      setSendResult(null);
                      setDraftSavedAt(null);
                      markRead(email);
                    }}
                    className={`inbox-row ${isSelected ? "is-selected" : ""}`}
                  >
                    <div
                      className="author-avatar"
                      style={{
                        width: 30,
                        height: 30,
                        marginTop: 1,
                        background: email.isRead
                          ? "linear-gradient(135deg, #F0F0EE, #E5E5E5)"
                          : "linear-gradient(135deg, #DBEAFE, #BFDBFE)",
                        color: email.isRead ? "var(--text-tertiary)" : "#1D4ED8",
                      }}
                    >
                      {initials}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            fontSize: 13,
                            color: email.isRead ? "var(--text-secondary)" : "var(--text)",
                            fontWeight: email.isRead ? 500 : 600,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          {email.from}
                        </span>
                        {!email.isRead && (
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: 3,
                              background: "var(--blue)",
                              flexShrink: 0,
                            }}
                          />
                        )}
                        {draftIds.has(email.id) && (
                          <span
                            title="Draft saved"
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              padding: "1px 6px",
                              borderRadius: 4,
                              background: "rgba(245, 158, 11, 0.12)",
                              color: "#92400E",
                              flexShrink: 0,
                              letterSpacing: "0.02em",
                            }}
                          >
                            DRAFT
                          </span>
                        )}
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--text-tertiary)",
                            flexShrink: 0,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {formatDate(email.createdAt)}
                        </span>
                      </div>
                      <p
                        style={{
                          fontSize: 12.5,
                          color: email.isRead ? "var(--text-tertiary)" : "var(--text)",
                          fontWeight: email.isRead ? 400 : 500,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          marginTop: 2,
                        }}
                      >
                        {email.subject}
                      </p>
                      {email.text && (
                        <p
                          style={{
                            fontSize: 11.5,
                            color: "var(--text-tertiary)",
                            marginTop: 2,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {email.text.slice(0, 90)}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Email Detail + Inline Reply ── */}
        <div
          style={{
            flex: 1,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "var(--shadow-sm)",
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {selected ? (
            <>
              {/* Header */}
              <div
                style={{
                  borderBottom: "1px solid var(--border-light)",
                  padding: "20px 24px",
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 8,
                  }}
                >
                  <h2
                    style={{
                      fontFamily: "var(--font-heading)",
                      fontSize: 18,
                      fontWeight: 600,
                      color: "var(--text)",
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {selected.subject}
                  </h2>
                  {!replyOpen && (
                    <button onClick={() => setReplyOpen(true)} className="btn btn-primary">
                      <Reply />
                      Reply
                    </button>
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                    fontSize: 12,
                    color: "var(--text-tertiary)",
                    flexWrap: "wrap",
                  }}
                >
                  <span>
                    From: <span style={{ color: "var(--text)" }}>{selected.from}</span>
                  </span>
                  <span>
                    To: <span style={{ color: "var(--text)" }}>{selected.to}</span>
                  </span>
                  <span>{new Date(selected.createdAt).toLocaleString()}</span>
                </div>
              </div>

              {/* Email Body */}
              <div style={{ padding: 24, flex: 1, overflow: "auto" }}>
                {sanitized ? (
                  <div
                    className="email-content"
                    style={{
                      borderRadius: 8,
                      background: "#FFFFFF",
                      color: "#1A1A1A",
                      padding: 20,
                      border: "1px solid var(--border-light)",
                    }}
                    dangerouslySetInnerHTML={{ __html: sanitized }}
                  />
                ) : (
                  <pre
                    style={{
                      fontSize: 13,
                      color: "var(--text)",
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-body)",
                    }}
                  >
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
                <div
                  style={{
                    borderTop: "1px solid var(--border-light)",
                    padding: "20px 24px",
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      borderRadius: 10,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      padding: 16,
                    }}
                  >
                    <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 12 }}>
                      Reply to <span style={{ color: "var(--text)" }}>{selected.from}</span>
                    </div>
                    <textarea
                      value={replyBody}
                      onChange={(e) => {
                        const v = e.target.value;
                        setReplyBody(v);
                        if (!selected) return;
                        if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
                        draftSaveTimer.current = setTimeout(() => {
                          if (v.trim()) {
                            localStorage.setItem(draftKey(selected.id), v);
                            setDraftSavedAt(Date.now());
                            setDraftIds((s) => new Set(s).add(selected.id));
                          } else {
                            localStorage.removeItem(draftKey(selected.id));
                            setDraftIds((s) => {
                              const next = new Set(s);
                              next.delete(selected.id);
                              return next;
                            });
                          }
                        }, 600);
                      }}
                      placeholder="Write your reply..."
                      rows={4}
                      autoFocus
                      style={{
                        width: "100%",
                        background: "transparent",
                        fontSize: 13,
                        color: "var(--text)",
                        border: "none",
                        resize: "none",
                        outline: "none",
                        marginBottom: 12,
                        fontFamily: "var(--font-body)",
                      }}
                    />
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <button
                          onClick={handleReply}
                          disabled={sending || !replyBody.trim()}
                          className="btn-send"
                        >
                          <Send />
                          {sending ? "Sending..." : "Send"}
                        </button>
                        <button
                          onClick={() => {
                            if (!selected) return;
                            if (replyBody.trim()) {
                              localStorage.setItem(draftKey(selected.id), replyBody);
                              setDraftSavedAt(Date.now());
                              setDraftIds((s) => new Set(s).add(selected.id));
                            }
                            setReplyOpen(false);
                          }}
                          disabled={!replyBody.trim()}
                          className="btn"
                        >
                          <FileText />
                          Save draft
                        </button>
                        <button
                          onClick={() => {
                            setReplyOpen(false);
                            setSendResult(null);
                          }}
                          className="btn"
                          style={{ background: "transparent", border: "none" }}
                        >
                          Close
                        </button>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        {draftSavedAt && (
                          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                            Draft saved
                          </span>
                        )}
                        {sendResult && (
                          <span
                            style={{
                              fontSize: 12,
                              color: sendResult.startsWith("Error")
                                ? "var(--coral)"
                                : "var(--green)",
                            }}
                          >
                            {sendResult}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
              }}
            >
              <div className="empty-state" style={{ border: "none", padding: 24 }}>
                <div className="empty-icon">
                  <Mail style={{ width: 20, height: 20 }} />
                </div>
                <h3>Nothing selected</h3>
                <p>Pick an email from the list to read or reply.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

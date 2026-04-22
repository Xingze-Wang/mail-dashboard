"use client";

import { useEffect, useState } from "react";
import {
  Plus,
  RefreshCw,
  ArrowLeft,
  Loader2,
  GraduationCap,
  Cpu,
  ExternalLink,
  Inbox as InboxIcon,
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

function computeBadgeClass(level: string | null) {
  if (level === "heavy") return "badge-compute heavy";
  if (level === "moderate") return "badge-compute moderate";
  if (level === "light") return "badge-compute light";
  return "badge-compute";
}

function BriefPanel({ email }: { email: Email }) {
  const [activated, setActivated] = useState(false);
  const [brief, setBrief] = useState<BriefData | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [talkingPoints, setTalkingPoints] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);

  // Reset when email changes
  useEffect(() => {
    setActivated(false);
    setBrief(null);
    setSummary(null);
    setTalkingPoints([]);
  }, [email.to]);

  const handleActivate = async () => {
    setActivated(true);
    setLoading(true);

    try {
      // 1. Fetch brief data
      const res = await fetch(`/api/brief?email=${encodeURIComponent(email.to)}`);
      const data = await res.json();
      const match = data.briefs?.[0] ?? null;
      setBrief(match);

      if (match) {
        // 2. Record WeChat addition
        fetch("/api/brief/wechat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: email.to,
            arxiv_id: match.paper.arxivId,
            lead_id: match.id,
          }),
        }).catch(() => {});

        // 3. Fetch AI summary + talking points
        setSummaryLoading(true);
        const sumRes = await fetch(`/api/brief/summary?id=${encodeURIComponent(match.id)}`);
        const sumData = await sumRes.json();
        setSummary(sumData.summary ?? null);
        setTalkingPoints(sumData.talkingPoints ?? []);
        setSummaryLoading(false);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  // Not activated yet — show the button
  if (!activated) {
    return (
      <button
        onClick={handleActivate}
        style={{
          width: "100%",
          borderRadius: 10,
          border: "1px solid #BBF7D0",
          background: "var(--green-bg)",
          padding: 20,
          textAlign: "center",
          cursor: "pointer",
          transition: "all 0.15s ease",
        }}
      >
        <p style={{ fontSize: 14, fontWeight: 600, color: "var(--green)", marginBottom: 4 }}>
          Added on WeChat
        </p>
        <p style={{ fontSize: 12, color: "var(--green)", opacity: 0.7 }}>
          Click to generate paper brief + talking points
        </p>
      </button>
    );
  }

  // Loading state
  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="skeleton" style={{ height: 80 }} />
        <div className="skeleton" style={{ height: 120 }} />
        <div className="skeleton" style={{ height: 100 }} />
      </div>
    );
  }

  // No match found
  if (!brief) {
    return (
      <div className="section-card" style={{ padding: 16 }}>
        <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
          No matching paper found for this email.
        </p>
      </div>
    );
  }

  const { paper, research } = brief;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Confirmed badge */}
      <div style={{ borderRadius: 8, background: "var(--green-bg)", border: "1px solid #BBF7D0", padding: "8px 14px" }}>
        <p style={{ fontSize: 11, color: "var(--green)", fontWeight: 600 }}>Added on WeChat — recorded</p>
      </div>

      {/* AI Summary */}
      <div style={{ borderRadius: 10, border: "1px solid #BFDBFE", background: "var(--blue-bg)", padding: 16 }}>
        <p style={{ fontSize: 11, color: "var(--blue)", fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Sales Brief
        </p>
        {summaryLoading ? (
          <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Generating brief...</p>
        ) : summary ? (
          <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, whiteSpace: "pre-line" }}>
            {summary}
          </p>
        ) : (
          <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No summary available</p>
        )}
      </div>

      {/* Paper info */}
      <div className="section-card" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Paper
          </p>
          {paper.pdfUrl && (
            <a
              href={paper.pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--blue)" }}
            >
              <ExternalLink style={{ width: 12, height: 12 }} />
              PDF
            </a>
          )}
        </div>
        <p style={{ fontSize: 13, color: "var(--text)", fontWeight: 600, marginBottom: 4 }}>{paper.title}</p>
        <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 8 }}>{paper.authors}</p>
        {paper.abstract && (
          <p style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            {paper.abstract}
          </p>
        )}
      </div>

      {/* Research profile */}
      <div className="section-card" style={{ padding: 16 }}>
        <p style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Research Profile
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {research.computeLevel && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Cpu style={{ width: 12, height: 12, color: "var(--text-tertiary)" }} />
              <span className={computeBadgeClass(research.computeLevel)}>
                {research.computeLevel}
              </span>
              {research.computeConfidence != null && (
                <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                  {Math.round((research.computeConfidence ?? 0) * 100)}%
                </span>
              )}
            </div>
          )}
          {research.computeReason && (
            <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>{research.computeReason}</p>
          )}
          {research.directions.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
              {research.directions.map((d) => (
                <span key={d} className="direction-tag" style={{ background: "var(--blue-bg)", color: "var(--blue)", borderColor: "#BFDBFE" }}>
                  {d}
                </span>
              ))}
            </div>
          )}
          {brief.personName && research.schoolName && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
              <GraduationCap style={{ width: 12, height: 12 }} />
              {brief.personName} · {research.schoolName}
            </div>
          )}
        </div>
      </div>

      {/* AI-generated talking points */}
      {talkingPoints.length > 0 && (
        <div className="section-card" style={{ padding: 16 }}>
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Talking Points
          </p>
          <ul style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12, color: "var(--text-secondary)" }}>
            {talkingPoints.map((point, i) => (
              <li key={i} style={{ display: "flex", gap: 8 }}>
                <span style={{ color: "var(--text-tertiary)", flexShrink: 0 }}>{i + 1}.</span>
                <span style={{ lineHeight: 1.6 }}>{point}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Author mismatch */}
      {brief.authorMismatch && (
        <div style={{ borderRadius: 10, border: "1px solid #FDE68A", background: "#FFFBEB", padding: 16 }}>
          <p style={{ fontSize: 11.5, color: "var(--gold)" }}>{brief.authorMismatch.note}</p>
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
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const fetchEmails = () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "50" });
    if (statusFilter) params.set("status", statusFilter);
    if (searchQuery) params.set("search", searchQuery);

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
  }, [page, statusFilter, searchQuery]);

  const statuses = ["all", "sent", "delivered", "clicked", "bounced", "complained"];

  // Detail view
  if (selected) {
    // Note: sanitizeHtml uses DOMPurify for XSS protection
    const sanitized = selected.html ? sanitizeHtml(selected.html) : "";

    return (
      <div>
        <button onClick={() => setSelected(null)} className="btn" style={{ marginBottom: 16 }}>
          <ArrowLeft />
          Back to emails
        </button>

        {/* Email header */}
        <div className="section-card" style={{ marginBottom: 16, padding: "16px 20px" }}>
          <h2 style={{ fontFamily: "var(--font-heading)", fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8, letterSpacing: "-0.01em" }}>
            {selected.subject}
          </h2>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 12, color: "var(--text-tertiary)", flexWrap: "wrap" }}>
            <span>To: <span style={{ color: "var(--text)" }}>{selected.to}</span></span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className={`h-1.5 w-1.5 rounded-full ${getStatusDot(selected.status)}`} />
              <span className={`capitalize ${getStatusColor(selected.status)}`} style={{ fontWeight: 600 }}>
                {selected.status}
              </span>
            </span>
            <span>{new Date(selected.createdAt).toLocaleString()}</span>
          </div>
        </div>

        {/* Two-column: left = email content, right = brief */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 16 }}>
          {/* Left: Email content */}
          <div className="section-card" style={{ padding: 20, minWidth: 0 }}>
            {detailLoading ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-tertiary)", fontSize: 13 }}>
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading email content...
              </div>
            ) : sanitized ? (
              <>
                <div
                  className="email-detail-content"
                  style={{ borderRadius: 8, background: "#FFFFFF", color: "#1A1A1A", padding: 20, border: "1px solid var(--border-light)" }}
                  dangerouslySetInnerHTML={{ __html: sanitized }}
                />
                <style>{`
                  .email-detail-content, .email-detail-content * { color: #1a1a1a !important; }
                  .email-detail-content a { color: #2563eb !important; }
                  .email-detail-content img { max-width: 100%; height: auto; }
                `}</style>
              </>
            ) : selected.text ? (
              <pre style={{ fontSize: 13, color: "var(--text)", whiteSpace: "pre-wrap", fontFamily: "var(--font-body)" }}>
                {selected.text}
              </pre>
            ) : (
              <p style={{ fontSize: 13, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                Content not available — this email may have expired from Resend&apos;s storage.
              </p>
            )}
          </div>

          {/* Right: Brief panel (sticky) */}
          <div style={{ minWidth: 0, position: "sticky", top: 24, alignSelf: "flex-start", maxHeight: "calc(100vh - 4rem)", overflowY: "auto" }}>
            <BriefPanel email={selected} />
          </div>
        </div>
      </div>
    );
  }

  // List view
  return (
    <div>
      {/* ── Page Header ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 className="page-title">Emails</h1>
          <span className="lead-count">{total} total</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={fetchEmails} className="btn">
            <RefreshCw />
            Refresh
          </button>
          <button onClick={() => setComposeOpen(true)} className="btn btn-primary">
            <Plus />
            Compose
          </button>
        </div>
      </div>

      {/* ── Search ── */}
      <form
        onSubmit={(e) => { e.preventDefault(); setSearchQuery(searchInput); setPage(1); }}
        style={{ marginBottom: 20 }}
      >
        <div style={{ position: "relative" }}>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { setSearchQuery(searchInput); setPage(1); }
            }}
            placeholder="Search by email address (e.g. zhang, mit.edu)..."
            className="search-input"
            style={{ width: "100%" }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => { setSearchInput(""); setSearchQuery(""); setPage(1); }}
              style={{
                position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border-light)",
                padding: "3px 10px", fontSize: 11, color: "var(--text-secondary)", cursor: "pointer",
              }}
            >
              Clear
            </button>
          )}
        </div>
        {searchQuery && (
          <p style={{ marginTop: 8, fontSize: 12, color: "var(--text-tertiary)" }}>
            Showing results for{" "}
            <span style={{ color: "var(--text)" }}>&ldquo;{searchQuery}&rdquo;</span>{" "}
            <span style={{ color: "var(--text-tertiary)" }}>({total} found)</span>
          </p>
        )}
      </form>

      {/* ── Status Filter ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20, alignItems: "center" }}>
        <div className="status-tabs">
          {statuses.map((s) => {
            const isActive = (s === "all" && !statusFilter) || s === statusFilter;
            return (
              <button
                key={s}
                onClick={() => { setStatusFilter(s === "all" ? null : s); setPage(1); }}
                className={`status-tab ${isActive ? "active" : ""}`}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Email List ── */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 56 }} />
          ))}
        </div>
      ) : emails.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <InboxIcon style={{ width: 20, height: 20 }} />
          </div>
          <h3>No emails found</h3>
          <p>{searchQuery ? "Try a different query." : "Compose your first email to see it here."}</p>
        </div>
      ) : (
        <div className="section-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>To / Subject</th>
                <th>From</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Date</th>
              </tr>
            </thead>
            <tbody>
              {emails.map((email) => (
                <tr key={email.id} onClick={() => openEmail(email)} style={{ cursor: "pointer" }}>
                  <td>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>
                        {email.to}
                      </p>
                      <p style={{ fontSize: 12, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2, fontWeight: 400 }}>
                        {email.subject}
                      </p>
                    </div>
                  </td>
                  <td>
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{email.from}</span>
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span className={`h-1.5 w-1.5 rounded-full ${getStatusDot(email.status)}`} />
                      <span className={`text-[12px] capitalize ${getStatusColor(email.status)}`} style={{ fontWeight: 600 }}>
                        {email.status}
                      </span>
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                      {formatDate(email.createdAt)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > 50 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16 }}>
          <button disabled={page === 1} onClick={() => setPage(page - 1)} className="btn" style={{ opacity: page === 1 ? 0.4 : 1 }}>
            Previous
          </button>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
            Page {page} of {Math.ceil(total / 50)}
          </span>
          <button disabled={page >= Math.ceil(total / 50)} onClick={() => setPage(page + 1)} className="btn" style={{ opacity: page >= Math.ceil(total / 50) ? 0.4 : 1 }}>
            Next
          </button>
        </div>
      )}

      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} />
    </div>
  );
}

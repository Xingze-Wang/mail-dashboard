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
  Send,
  CheckCircle2,
  MailOpen,
  MousePointer2,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import { formatDate, getStatusColor, getStatusDot } from "@/lib/utils";
import { ComposeModal } from "@/components/compose-modal";
import { sanitizeHtml } from "@/lib/sanitize";
import { MpSignalPills, type MpSignals } from "@/components/MpSignalPills";

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
  id: string | null;
  personName: string;
  firstName: string | null;
  paper: {
    title: string;
    arxivId: string;
    pdfUrl: string | null;
    abstract: string | null;
    authors: string | null;
    publishedAt: string | null;
  } | null;
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
  source?: "pipeline_lead" | "paper_author" | "email-only";
  // From /api/brief — registered/submittedApplication/addedWechat trio.
  // Null when we have no email to join on. See getMpSignalsForEmails().
  mpSignals?: (MpSignals & { applicationProgress?: string | null }) | null;
}

function computeBadgeClass(level: string | null) {
  if (level === "heavy") return "badge-compute heavy";
  if (level === "moderate") return "badge-compute moderate";
  if (level === "light") return "badge-compute light";
  return "badge-compute";
}

interface ClickEvent {
  type: string;
  occurredAt: string;
  link: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  timestamp: string | null;
}

// Resend-style horizontal stepper: icon + label + timestamp per event,
// connector lines between, pastel pills colored by event type. Click
// links appear as a quiet expandable list below the stepper.
function ClickHistory({ emailId }: { emailId: string }) {
  const [data, setData] = useState<{
    eventCount: number;
    clickCount: number;
    distinctLinkCount: number;
    events: ClickEvent[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showLinks, setShowLinks] = useState(false);

  useEffect(() => {
    // Drop the stale state synchronously so the spinner always renders
    // for the new emailId (otherwise switching between two emails could
    // briefly show the OLD email's events while the new fetch is in
    // flight, AND — more relevant to the 2026-05-09 smoke — a 200 body
    // with events=[] used to leave loading=true forever in StrictMode
    // because `cancelled` from the first effect blocked the only
    // setLoading(false) call. Now we set loading directly here and use
    // an AbortController for proper cleanup, no closure trickery.
    setLoading(true);
    setFetchError(null);
    setData(null);

    const ac = new AbortController();
    let aborted = false;
    fetch(`/api/emails/${emailId}/clicks`, { signal: ac.signal })
      .then(async (r) => {
        if (!r.ok) {
          setFetchError(`HTTP ${r.status}`);
          return null;
        }
        try {
          return await r.json();
        } catch {
          setFetchError("Invalid JSON response");
          return null;
        }
      })
      .then((d) => {
        if (aborted) return;
        // Always normalize so the render path can trust shape.
        if (d && typeof d === "object") {
          setData({
            eventCount: typeof d.eventCount === "number" ? d.eventCount : (Array.isArray(d.events) ? d.events.length : 0),
            clickCount: typeof d.clickCount === "number" ? d.clickCount : 0,
            distinctLinkCount: typeof d.distinctLinkCount === "number" ? d.distinctLinkCount : 0,
            events: Array.isArray(d.events) ? d.events : [],
          });
        }
      })
      .catch((e) => {
        if (aborted) return;
        if ((e as Error)?.name === "AbortError") return;
        setFetchError(String(e));
      })
      .finally(() => {
        // Setting loading=false unconditionally — the AbortController
        // already prevented the stale fetch from racing, and leaving
        // loading=true on cleanup was the original "spinner forever" bug.
        if (!aborted) setLoading(false);
      });
    return () => {
      aborted = true;
      ac.abort();
    };
  }, [emailId]);

  if (loading) return (
    <div style={{ marginTop: 24, fontSize: 12, color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 6 }}>
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading events…
    </div>
  );
  if (fetchError) return (
    <div style={{ marginTop: 24, fontSize: 12, color: "#ef4444" }}>Events error: {fetchError}</div>
  );
  if (!data || data.eventCount === 0) return null;

  const clicks = data.events.filter((e) => e.type === "email.clicked");

  // Per-event visual config — icon + tint that matches Resend's stepper.
  const cfg: Record<string, { label: string; Icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; tint: string; ring: string; iconColor: string }> = {
    "email.sent":       { label: "Sent",       Icon: Send,         tint: "#F1F5F9", ring: "#CBD5E1", iconColor: "#475569" },
    "email.delivered":  { label: "Delivered",  Icon: CheckCircle2, tint: "#ECFDF5", ring: "#A7F3D0", iconColor: "#059669" },
    "email.opened":     { label: "Opened",     Icon: MailOpen,     tint: "#EFF6FF", ring: "#BFDBFE", iconColor: "#2563EB" },
    "email.clicked":    { label: "Clicked",    Icon: MousePointer2, tint: "#F5F3FF", ring: "#DDD6FE", iconColor: "#7C3AED" },
    "email.bounced":    { label: "Bounced",    Icon: XCircle,      tint: "#FEF2F2", ring: "#FCA5A5", iconColor: "#DC2626" },
    "email.complained": { label: "Complained", Icon: AlertTriangle, tint: "#FFFBEB", ring: "#FDE68A", iconColor: "#D97706" },
  };
  const fallback = cfg["email.sent"];

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
        Email events
      </div>

      {/* Stepper — icon dots in a row connected by hairlines */}
      <div style={{
        position: "relative",
        display: "flex",
        gap: 0,
        overflowX: "auto",
        padding: "8px 4px 14px",
      }}>
        {data.events.map((e, i) => {
          const c = cfg[e.type] ?? fallback;
          const Icon = c.Icon;
          const isLast = i === data.events.length - 1;
          return (
            <div key={i} style={{
              display: "flex",
              alignItems: "flex-start",
              flex: isLast ? "0 0 auto" : "1 1 0",
              minWidth: 96,
            }}>
              {/* Step body */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: 0 }}>
                <div style={{
                  width: 38, height: 38, borderRadius: "50%",
                  background: c.tint,
                  border: `1.5px solid ${c.ring}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}>
                  <Icon className="h-[18px] w-[18px]" style={{ color: c.iconColor }} />
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{c.label}</div>
                <div style={{ fontSize: 10.5, color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
                  {new Date(e.timestamp ?? e.occurredAt).toLocaleString(undefined, {
                    month: "short", day: "numeric",
                    hour: "numeric", minute: "2-digit",
                  })}
                </div>
              </div>
              {/* Connector */}
              {!isLast && (
                <div style={{
                  flex: 1,
                  height: 1.5,
                  background: "var(--border)",
                  marginTop: 19, // align to icon center (38/2)
                  minWidth: 16,
                }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Click links — collapsed by default, expand to see destinations */}
      {clicks.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => setShowLinks((v) => !v)}
            style={{
              fontSize: 11.5, color: "var(--text-tertiary)",
              background: "transparent", border: 0, cursor: "pointer",
              padding: 0, display: "inline-flex", alignItems: "center", gap: 4,
            }}
          >
            {showLinks ? "Hide" : "Show"} {clicks.length} click destination{clicks.length === 1 ? "" : "s"}
            {data.distinctLinkCount > 1 ? ` · ${data.distinctLinkCount} distinct` : ""}
          </button>
          {showLinks && (
            <ul style={{
              marginTop: 8,
              display: "flex", flexDirection: "column", gap: 8,
              fontSize: 11.5,
              padding: "10px 12px",
              background: "var(--bg)",
              border: "1px solid var(--border-light)",
              borderRadius: 6,
            }}>
              {clicks.map((c, i) => (
                <li key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ color: "var(--text)", wordBreak: "break-all" }}>
                    {c.link ?? "(unknown link)"}
                  </span>
                  <span style={{ color: "var(--text-tertiary)" }}>
                    {new Date(c.timestamp ?? c.occurredAt).toLocaleString()}
                    {c.ipAddress ? ` · ${c.ipAddress}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function BriefPanel({ email }: { email: Email }) {
  const [activated, setActivated] = useState(false);
  const [brief, setBrief] = useState<BriefData | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [talkingPoints, setTalkingPoints] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [wechatError, setWechatError] = useState<string | null>(null);

  // Reset when email changes
  useEffect(() => {
    setActivated(false);
    setBrief(null);
    setSummary(null);
    setTalkingPoints([]);
    setWechatError(null);
  }, [email.to]);

  const handleActivate = async () => {
    setActivated(true);
    setLoading(true);

    try {
      // 1. Fetch brief data
      const res = await fetch(`/api/brief?email=${encodeURIComponent(email.to)}`);
      const data = await res.json();
      const match: BriefData | null = data.briefs?.[0] ?? null;
      setBrief(match);

      // 2. Record WeChat addition — fire regardless of whether we have a
      // real pipeline_lead match. The /api/brief/wechat route accepts
      // null lead_id / arxiv_id (plain insert path), so legacy emails
      // with no pipeline_lead row can still record the conversion.
      //
      // For legacy paper-author hits, the brief may set `id` to the arxiv
      // string (not a UUID); in that case we send null so the API takes
      // the plain-insert branch instead of upserting against a non-FK id.
      const candidateLeadId = typeof match?.id === "string" && /^[0-9a-f-]{36}$/i.test(match.id)
        ? match.id
        : null;
      try {
        const wechatRes = await fetch("/api/brief/wechat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: email.to,
            arxiv_id: match?.paper?.arxivId ?? null,
            lead_id: candidateLeadId,
          }),
        });
        if (!wechatRes.ok) {
          const body = await wechatRes.json().catch(() => ({}));
          // Surface the failure so the rep doesn't see a green "recorded"
          // badge for a conversion that didn't actually land in the DB.
          // Common failure mode for legacy emails: marked_by_rep_id /
          // wechat_at column missing in this prod's brief_lookups.
          setWechatError(body.error || `Failed (HTTP ${wechatRes.status})`);
        } else {
          setWechatError(null);
        }
      } catch (err) {
        setWechatError(err instanceof Error ? err.message : "Network error");
      }

      // 3. Fetch AI summary + talking points — only when we have a real
      // lead with a paper; the synthetic email-only brief has no id and
      // nothing for the summarizer to chew on.
      if (match && match.id && match.paper && match.source !== "email-only") {
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

  // Not activated yet — quiet outlined call-to-action.
  if (!activated) {
    return (
      <button
        onClick={handleActivate}
        style={{
          width: "100%",
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--card)",
          padding: "12px 14px",
          textAlign: "left",
          cursor: "pointer",
          display: "flex", alignItems: "center", gap: 10,
          transition: "border-color 0.15s ease, background 0.15s ease",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#16a34a"; e.currentTarget.style.background = "var(--bg)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--card)"; }}
      >
        <div style={{
          width: 28, height: 28, borderRadius: "50%",
          background: "#ECFDF5", border: "1px solid #A7F3D0",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>
          <CheckCircle2 className="h-4 w-4" style={{ color: "#059669" }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Mark added on WeChat</div>
          <div style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>Records conversion · loads paper brief</div>
        </div>
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

  // No brief at all (shouldn't happen now — /api/brief returns a synthetic
  // email-only brief as a fallback — but keep this as a defensive empty state
  // for the truly-empty case, e.g. an API error).
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
  const isEmailOnly = brief.source === "email-only" || !paper;

  // Synthetic / legacy email-only brief: no paper match in pipeline_leads.
  // Render a minimal card so the rep can still see the WeChat-recorded
  // confirmation and (the API call already fired in handleActivate) know
  // the conversion was logged.
  if (isEmailOnly) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {wechatError ? (
          <div style={{ borderRadius: 8, background: "#FEF2F2", border: "1px solid #FCA5A5", padding: "8px 14px" }}>
            <p style={{ fontSize: 11, color: "#B91C1C", fontWeight: 600 }}>WeChat conversion NOT recorded</p>
            <p style={{ fontSize: 11, color: "#B91C1C", opacity: 0.9, marginTop: 2 }}>{wechatError}</p>
          </div>
        ) : (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            alignSelf: "flex-start",
            fontSize: 11.5, fontWeight: 500, color: "#059669",
            padding: "4px 10px", borderRadius: 999,
            background: "#ECFDF5", border: "1px solid #A7F3D0",
          }}>
            <MpSignalPills
              signals={brief.mpSignals ?? null}
              size="md"
              showLabels
              applicationProgress={brief.mpSignals?.applicationProgress ?? null}
            />
            <span>注册 · 开表 · 微信</span>
          </div>
        )}
        <div className="section-card" style={{ padding: 16 }}>
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Recipient
          </p>
          <p style={{ fontSize: 13, color: "var(--text)", fontWeight: 600, marginBottom: 4 }}>{brief.personName}</p>
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 8 }}>{email.to}</p>
          <p style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            No matching paper in the pipeline for this email (sent via legacy path). The WeChat conversion has still been recorded.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* MP signal trio — 注 / 开 / 微. Swapped in for the legacy
          "Added on WeChat — recorded" single-state badge so the rep
          sees registered + submitted-application + wechat at a glance.
          (The "Mark added on WeChat" CTA stays the activate button
          above; this block is the post-activate confirmation row.) */}
      <div
        style={{
          borderRadius: 8,
          background: "var(--green-bg)",
          border: "1px solid #BBF7D0",
          padding: "8px 14px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <MpSignalPills
          signals={brief.mpSignals ?? null}
          size="md"
          showLabels
          applicationProgress={brief.mpSignals?.applicationProgress ?? null}
        />
        <span style={{ fontSize: 11, color: "var(--green)", fontWeight: 600 }}>
          注册 · 开表 · 微信
        </span>
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
  const [truncated, setTruncated] = useState(false);
  const [scannedTotal, setScannedTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [selected, setSelected] = useState<Email | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  // Sending vs Receiving tabs (Resend-style). Sending pulls from `emails`
  // table (outbound); Receiving pulls from `inbound_emails` and renders
  // with `from` shown as the row's primary recipient field.
  const [direction, setDirection] = useState<"sending" | "receiving">("sending");

  const fetchEmails = () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "50" });
    if (statusFilter) params.set("status", statusFilter);
    if (searchQuery) params.set("search", searchQuery);

    const path = direction === "sending" ? `/api/emails?${params}` : `/api/inbound?${params}`;
    fetch(path)
      .then((res) => res.json())
      .then((data) => {
        // Normalize inbound rows into the Email shape so the existing
        // table / detail view works without further branching. Inbound
        // rows have `from` populated and `to` = our send address; we
        // surface `from` as the primary identifier (matches Resend UI).
        if (direction === "receiving") {
          const normalized: Email[] = (data.emails ?? []).map((row: {
            id: string; from: string; to: string; subject: string;
            html?: string | null; text?: string | null; created_at: string; thread_id?: string | null;
          }) => ({
            id: row.id,
            from: row.from,
            // Show `from` (sender) as `to` so the existing "To" column
            // labels render the OTHER party — what the user wants to see
            // at a glance is "who is this from."
            to: row.from,
            subject: row.subject ?? "(no subject)",
            html: row.html ?? "",
            text: row.text ?? null,
            status: "received",
            createdAt: row.created_at,
            resendId: null,
          }));
          setEmails(normalized);
        } else {
          // Defensive: API may return {error} on 4xx/5xx; coerce missing
          // emails array to [] so the list pane settles to "no rows" UI
          // instead of staying skeleton (one of the 2026-05-09 smoke
          // findings was an 8s skeleton that resolved to no data).
          setEmails(Array.isArray(data?.emails) ? data.emails : []);
        }
        setTotal(data.total ?? data.emails?.length ?? 0);
        setTruncated(!!data.truncated);
        setScannedTotal(typeof data.scannedTotal === "number" ? data.scannedTotal : null);
      })
      .catch((err) => {
        console.error(err);
        // Fail loudly in the UI instead of leaving stale data + spinner.
        setEmails([]);
        setTotal(0);
      })
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
    // direction must be in deps so switching tabs refetches
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, statusFilter, searchQuery, direction]);

  const statuses = direction === "sending"
    ? ["all", "sent", "delivered", "clicked", "bounced", "complained"]
    : ["all"]; // inbound has no per-status filter — every row is "received"

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
            <ClickHistory emailId={selected.id} />
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
          {/* Render "—" while loading rather than a hard "0 total" — the
              smoke flagged the contradiction between "0 total" in the
              header and ~50 rows landing 8s later. The em-dash signals
              "we don't know yet," not "there are zero." */}
          <span className="lead-count">{loading ? "— total" : `${total} total`}</span>
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

      {/* ── Sending / Receiving tabs (Resend-style) ── */}
      <div style={{ display: "flex", gap: 0, marginBottom: 20, borderBottom: "1px solid var(--border-light)" }}>
        {(["sending", "receiving"] as const).map((d) => {
          const active = direction === d;
          return (
            <button
              key={d}
              onClick={() => { setDirection(d); setPage(1); setStatusFilter(null); }}
              style={{
                padding: "10px 16px",
                fontSize: 14,
                fontWeight: active ? 600 : 500,
                color: active ? "var(--text)" : "var(--text-tertiary)",
                background: "transparent",
                border: "none",
                borderBottom: active ? "2px solid var(--blue)" : "2px solid transparent",
                marginBottom: -1,
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {d}
            </button>
          );
        })}
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
        {truncated && searchQuery && scannedTotal != null && (
          <p style={{ marginTop: 6, fontSize: 12, color: "var(--text-warning, #b45309)" }}>
            Search scanned the {scannedTotal} most recent emails. Older matches may exist — narrow the term to see further back.
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

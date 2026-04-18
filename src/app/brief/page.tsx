"use client";

import { useState, useEffect } from "react";
import {
  FileText,
  User,
  Mail,
  ArrowLeft,
  ExternalLink,
  AlertTriangle,
  GraduationCap,
  Cpu,
  Compass,
  Clock,
  Send,
} from "lucide-react";
import { formatDate } from "@/lib/utils";

interface Paper {
  title: string;
  arxivId: string;
  pdfUrl: string | null;
  abstract: string | null;
  authors: string | null;
  publishedAt: string | null;
}

interface Brief {
  id: string;
  personName: string;
  firstName: string | null;
  paper: Paper;
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
    subject: string | null;
    status: string;
    sentAt: string | null;
  };
  authorMismatch: {
    note: string;
    emailedPerson: string;
    searchedPerson: string;
  } | null;
  matchTypes: string[];
  createdAt: string;
}

function computeBadgeClass(level: string | null) {
  if (level === "heavy") return "badge-compute heavy";
  if (level === "moderate") return "badge-compute moderate";
  if (level === "light") return "badge-compute light";
  return "badge-compute";
}

function statusBadgeClass(status: string) {
  if (status === "sent") return "badge-status sent";
  if (status === "ready") return "badge-status ready";
  if (status === "skipped") return "badge-status skipped";
  if (status === "replied") return "badge-status replied";
  return "badge-status nurture";
}

function tierLabel(tier: number | null) {
  if (tier === 1) return "Tier 1";
  if (tier === 2) return "Tier 2";
  if (tier === 3) return "Tier 3";
  return null;
}

// ─── Search Results List ────────────────────────────────────────────────────

function ResultCard({
  brief,
  onSelect,
}: {
  brief: Brief;
  onSelect: () => void;
}) {
  const isMismatch = !!brief.authorMismatch;

  return (
    <button
      onClick={onSelect}
      className="lead-card"
      style={{ width: "100%", textAlign: "left", padding: 16, cursor: "pointer", display: "block" }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {brief.personName}
            </span>
            {isMismatch && (
              <span
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 600,
                  background: "#FFFBEB", color: "var(--gold)", border: "1px solid #FDE68A",
                }}
              >
                <AlertTriangle style={{ width: 12, height: 12 }} />
                Co-author
              </span>
            )}
            {brief.outreach.status === "sent" && (
              <span className="badge-status sent" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <Send style={{ width: 12, height: 12 }} />
                Emailed
              </span>
            )}
          </div>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 6 }}>
            {brief.paper.title}
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "var(--text-tertiary)", flexWrap: "wrap" }}>
            {brief.research.schoolName && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <GraduationCap style={{ width: 12, height: 12 }} />
                {brief.research.schoolName}
              </span>
            )}
            {brief.research.computeLevel && (
              <span className={computeBadgeClass(brief.research.computeLevel)}>
                {brief.research.computeLevel}
              </span>
            )}
            {brief.paper.publishedAt && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <Clock style={{ width: 12, height: 12 }} />
                {formatDate(brief.paper.publishedAt)}
              </span>
            )}
          </div>
        </div>
        <div style={{ color: "var(--text-tertiary)", marginTop: 4 }}>
          <FileText style={{ width: 16, height: 16 }} />
        </div>
      </div>
      {isMismatch && (
        <p style={{ marginTop: 8, fontSize: 11, color: "var(--gold)", lineHeight: 1.6 }}>
          We emailed {brief.authorMismatch!.emailedPerson} — this person is a
          co-author on the same paper
        </p>
      )}
    </button>
  );
}

// ─── Detail View ────────────────────────────────────────────────────────────

function DetailView({
  brief,
  onBack,
}: {
  brief: Brief;
  onBack: () => void;
}) {
  const { paper, research, outreach, authorMismatch } = brief;
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [wechatMarked, setWechatMarked] = useState(false);
  const [wechatSaving, setWechatSaving] = useState(false);

  useEffect(() => {
    setSummaryLoading(true);
    fetch(`/api/brief/summary?id=${encodeURIComponent(brief.id)}`)
      .then((r) => r.json())
      .then((d) => setSummary(d.summary ?? null))
      .catch(() => setSummary(null))
      .finally(() => setSummaryLoading(false));

    // Check if already marked
    const params = new URLSearchParams();
    if (brief.paper.arxivId) params.set("arxiv_id", brief.paper.arxivId);
    else params.set("lead_id", brief.id);
    fetch(`/api/brief/wechat?${params}`)
      .then((r) => r.json())
      .then((d) => setWechatMarked(d.addedWechat))
      .catch(() => {});
  }, [brief.id, brief.paper.arxivId]);

  const markWechat = async () => {
    setWechatSaving(true);
    try {
      await fetch("/api/brief/wechat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: brief.personName,
          arxiv_id: brief.paper.arxivId,
          lead_id: brief.id,
        }),
      });
      setWechatMarked(true);
    } catch {
      // ignore
    } finally {
      setWechatSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={onBack} className="btn">
          <ArrowLeft />
          Back to results
        </button>

        {wechatMarked ? (
          <span className="badge-status replied" style={{ padding: "5px 14px" }}>
            Added on WeChat
          </span>
        ) : (
          <button onClick={markWechat} disabled={wechatSaving} className="btn btn-primary">
            {wechatSaving ? "Saving..." : "Mark: Added on WeChat"}
          </button>
        )}
      </div>

      {/* AI Summary — the main thing sales reads */}
      <div style={{ borderRadius: 10, border: "1px solid #BFDBFE", background: "var(--blue-bg)", padding: 20 }}>
        <h3 style={{ fontFamily: "var(--font-heading)", fontSize: 16, fontWeight: 600, color: "var(--blue)", marginBottom: 12, letterSpacing: "-0.01em" }}>
          Sales Brief
        </h3>
        {summaryLoading ? (
          <p style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Generating brief...</p>
        ) : summary ? (
          <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.7, whiteSpace: "pre-line" }}>
            {summary}
          </p>
        ) : (
          <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Unable to generate summary</p>
        )}
      </div>

      {/* Header */}
      <div className="section-card" style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div>
            <h2 style={{ fontFamily: "var(--font-heading)", fontSize: 20, fontWeight: 600, color: "var(--text)", marginBottom: 4, letterSpacing: "-0.01em" }}>
              {brief.personName}
            </h2>
            {research.schoolName && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>
                <GraduationCap style={{ width: 14, height: 14 }} />
                {research.schoolName}
                {tierLabel(research.schoolTier) && (
                  <span style={{ color: "var(--text-tertiary)" }}>
                    ({tierLabel(research.schoolTier)})
                  </span>
                )}
              </div>
            )}
          </div>
          {paper.pdfUrl && (
            <a href={paper.pdfUrl} target="_blank" rel="noopener noreferrer" className="btn">
              <ExternalLink />
              PDF
            </a>
          )}
        </div>
      </div>

      {/* Author mismatch warning */}
      {authorMismatch && (
        <div style={{ borderRadius: 10, border: "1px solid #FDE68A", background: "#FFFBEB", padding: 16 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <AlertTriangle style={{ width: 16, height: 16, color: "var(--gold)", marginTop: 2, flexShrink: 0 }} />
            <div>
              <p style={{ fontSize: 13, fontWeight: 600, color: "var(--gold)", marginBottom: 4 }}>
                Author Mismatch
              </p>
              <p style={{ fontSize: 12, color: "var(--gold)", opacity: 0.9, lineHeight: 1.6 }}>
                {authorMismatch.note}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Paper info */}
      <div className="section-card" style={{ padding: 20 }}>
        <h3 style={{ fontFamily: "var(--font-heading)", fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <FileText style={{ width: 14, height: 14 }} />
          Paper
        </h3>
        <p style={{ fontSize: 14, color: "var(--text)", fontWeight: 600, marginBottom: 8 }}>
          {paper.title}
        </p>
        <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 12 }}>
          {paper.authors}
        </p>
        {paper.abstract && (
          <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            {paper.abstract.length > 600
              ? paper.abstract.slice(0, 600) + "..."
              : paper.abstract}
          </p>
        )}
      </div>

      {/* Research profile */}
      <div className="section-card" style={{ padding: 20 }}>
        <h3 style={{ fontFamily: "var(--font-heading)", fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <Cpu style={{ width: 14, height: 14 }} />
          Research Profile
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          {research.computeLevel && (
            <div>
              <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>
                Compute Need
              </p>
              <span className={computeBadgeClass(research.computeLevel)}>
                {research.computeLevel}
              </span>
              {research.computeConfidence != null && (
                <span style={{ marginLeft: 8, fontSize: 11, color: "var(--text-tertiary)" }}>
                  {Math.round(research.computeConfidence * 100)}% conf
                </span>
              )}
            </div>
          )}
          {research.directions.length > 0 && (
            <div>
              <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>
                <Compass style={{ width: 12, height: 12, display: "inline", marginRight: 4 }} />
                Directions
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {research.directions.map((d) => (
                  <span key={d} className="direction-tag" style={{ background: "var(--blue-bg)", color: "var(--blue)", borderColor: "#BFDBFE" }}>
                    {d}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
        {research.computeReason && (
          <p style={{ marginTop: 12, fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            {research.computeReason}
          </p>
        )}
      </div>

      {/* Outreach status */}
      <div className="section-card" style={{ padding: 20 }}>
        <h3 style={{ fontFamily: "var(--font-heading)", fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <Mail style={{ width: 14, height: 14 }} />
          Outreach
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-tertiary)" }}>Emailed to</span>
            <span style={{ color: "var(--text)" }}>{outreach.emailedTo}</span>
          </div>
          {outreach.emailedName && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-tertiary)" }}>Contact name</span>
              <span style={{ color: "var(--text)" }}>{outreach.emailedName}</span>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-tertiary)" }}>Status</span>
            <span className={statusBadgeClass(outreach.status)}>{outreach.status}</span>
          </div>
          {outreach.sentAt && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-tertiary)" }}>Sent at</span>
              <span style={{ color: "var(--text)" }}>{formatDate(outreach.sentAt)}</span>
            </div>
          )}
          {outreach.subject && (
            <div style={{ paddingTop: 8, borderTop: "1px solid var(--border-light)" }}>
              <p style={{ color: "var(--text-tertiary)", marginBottom: 4 }}>Subject</p>
              <p style={{ color: "var(--text)" }}>{outreach.subject}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function BriefPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Brief[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Brief | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || query.trim().length < 2) return;

    setLoading(true);
    setSelected(null);
    try {
      const res = await fetch(
        `/api/brief?name=${encodeURIComponent(query.trim())}`,
      );
      const data = await res.json();
      setResults(data.briefs ?? []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  const isEmpty = !selected && results === null;

  return (
    <div style={{ maxWidth: 880, margin: "0 auto" }}>
      {/* Header — only show in non-hero mode */}
      {!isEmpty && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <User style={{ width: 24, height: 24 }} />
              Sales Brief
            </h1>
            <span className="lead-count">Look up authors</span>
          </div>
        </div>
      )}

      {/* Hero search — when empty / first load */}
      {isEmpty && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "60vh",
            padding: "0 16px",
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              background: "var(--bg)",
              border: "1px solid var(--border-light)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 18,
              color: "var(--text-secondary)",
            }}
          >
            <User style={{ width: 26, height: 26 }} />
          </div>
          <h1
            className="page-title"
            style={{ fontSize: 32, marginBottom: 10, textAlign: "center" }}
          >
            Sales Brief
          </h1>
          <p
            style={{
              fontSize: 13.5,
              color: "var(--text-secondary)",
              marginBottom: 28,
              textAlign: "center",
              maxWidth: 480,
              lineHeight: 1.6,
            }}
          >
            Look up an author by name to see their paper, research profile, and outreach history.
          </p>
          <form onSubmit={handleSearch} style={{ width: "100%", maxWidth: 540 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Enter first name, e.g. Jiahao"
                className="search-input"
                style={{ flex: 1, padding: "12px 16px 12px 38px", fontSize: 14, backgroundPosition: "12px center" }}
                autoFocus
              />
              <button
                type="submit"
                disabled={loading || query.trim().length < 2}
                className="btn btn-primary"
                style={{ padding: "10px 20px" }}
              >
                {loading ? "Searching..." : "Search"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Condensed search row — once results are showing */}
      {!isEmpty && !selected && (
        <form onSubmit={handleSearch} style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ position: "relative", flex: 1 }}>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Enter first name, e.g. Jiahao"
                className="search-input"
                style={{ width: "100%" }}
              />
            </div>
            <button
              type="submit"
              disabled={loading || query.trim().length < 2}
              className="btn btn-primary"
            >
              {loading ? "Searching..." : "Search"}
            </button>
          </div>
        </form>
      )}

      {/* Results */}
      {selected ? (
        <DetailView brief={selected} onBack={() => setSelected(null)} />
      ) : results !== null ? (
        results.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <User style={{ width: 20, height: 20 }} />
            </div>
            <h3>No matches found</h3>
            <p>
              Nothing for &ldquo;{query}&rdquo;. Try a different spelling or check the pipeline.
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 4 }}>
              {results.length} result{results.length !== 1 && "s"} for &ldquo;{query}&rdquo;
            </p>
            {results.map((b) => (
              <ResultCard key={b.id} brief={b} onSelect={() => setSelected(b)} />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

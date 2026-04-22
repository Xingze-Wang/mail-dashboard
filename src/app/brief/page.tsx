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
  Copy,
  Check,
  RefreshCw,
  MessageCircle,
  Sparkles,
  Zap,
  X,
  Loader2,
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
  const [structured, setStructured] = useState<{
    paper: string;
    mainIdea: string;
    coreInnovation: string;
    questions: string[];
    approach: string;
    persuasionAngle?: "ethos" | "logos" | "pathos";
    angleHint?: string;
  } | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [wechatMarked, setWechatMarked] = useState(false);
  const [wechatSaving, setWechatSaving] = useState(false);
  const [wechatAt, setWechatAt] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const loadBrief = (bustCache = false) => {
    setSummaryLoading(true);
    const url = `/api/brief/summary?id=${encodeURIComponent(brief.id)}${bustCache ? `&t=${Date.now()}` : ""}`;
    fetch(url, bustCache ? { cache: "no-store" } : undefined)
      .then((r) => r.json())
      .then((d) => {
        if (d.paper && d.mainIdea && d.coreInnovation && Array.isArray(d.questions) && d.approach) {
          setStructured({
            paper: d.paper,
            mainIdea: d.mainIdea,
            coreInnovation: d.coreInnovation,
            questions: d.questions,
            approach: d.approach,
            persuasionAngle: d.persuasionAngle,
            angleHint: d.angleHint,
          });
        } else if (d.summary) {
          setStructured({ paper: "", mainIdea: d.summary, coreInnovation: "", questions: [], approach: "" });
        } else {
          setStructured(null);
        }
      })
      .catch(() => setStructured(null))
      .finally(() => setSummaryLoading(false));
  };

  useEffect(() => {
    loadBrief(false);

    // Check if already marked
    const params = new URLSearchParams();
    if (brief.paper.arxivId) params.set("arxiv_id", brief.paper.arxivId);
    else params.set("lead_id", brief.id);
    fetch(`/api/brief/wechat?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setWechatMarked(!!d.addedWechat);
        setWechatAt(d.record?.wechat_at ?? null);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief.id, brief.paper.arxivId]);

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    } catch {
      // navigator.clipboard is unavailable on http or old browsers; no-op.
    }
  };

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
      setWechatAt(new Date().toISOString());
    } catch {
      // ignore
    } finally {
      setWechatSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <button onClick={onBack} className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <ArrowLeft style={{ width: 14, height: 14 }} />
          Back to results
        </button>

        {wechatMarked ? (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 14px", borderRadius: 999, background: "#ECFDF5", border: "1px solid #A7F3D0", color: "#047857", fontSize: 12, fontWeight: 500 }}>
            <Check style={{ width: 14, height: 14 }} />
            Added on WeChat
            {wechatAt && (
              <span style={{ color: "#047857", opacity: 0.7, marginLeft: 4 }}>
                · {formatDate(wechatAt)}
              </span>
            )}
          </div>
        ) : (
          <button
            onClick={markWechat}
            disabled={wechatSaving}
            className="btn btn-primary"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <MessageCircle style={{ width: 14, height: 14 }} />
            {wechatSaving ? "Saving…" : "Mark: Added on WeChat"}
          </button>
        )}
      </div>

      {/* Name header (compact) */}
      <div className="section-card" style={{ padding: 16 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div>
            <h2 style={{ fontFamily: "var(--font-heading)", fontSize: 20, fontWeight: 600, color: "var(--text)", marginBottom: 4, letterSpacing: "-0.01em" }}>
              {brief.personName}
            </h2>
            {research.schoolName && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)" }}>
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
            <a href={paper.pdfUrl} target="_blank" rel="noopener noreferrer" className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ExternalLink style={{ width: 14, height: 14 }} />
              PDF
            </a>
          )}
        </div>
      </div>

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

      {/* Main two-column: brief on left (primary), paper+research context on right */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)", gap: 20 }}>

        {/* LEFT: Sales Brief — the thing sales actually reads */}
        <div style={{ borderRadius: 10, border: "1px solid #BFDBFE", background: "var(--blue-bg)", padding: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 14 }}>
            <h3 style={{ fontFamily: "var(--font-heading)", fontSize: 16, fontWeight: 600, color: "var(--blue)", letterSpacing: "-0.01em", display: "inline-flex", alignItems: "center", gap: 8, margin: 0 }}>
              <Sparkles style={{ width: 16, height: 16 }} />
              Sales Brief
            </h3>
            <div style={{ display: "flex", gap: 8 }}>
              {structured && !summaryLoading && (
                <button
                  onClick={() => copyToClipboard(briefToPlain(structured), "all")}
                  className="btn"
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, padding: "4px 10px" }}
                >
                  {copiedKey === "all" ? <Check style={{ width: 12, height: 12 }} /> : <Copy style={{ width: 12, height: 12 }} />}
                  {copiedKey === "all" ? "Copied" : "Copy all"}
                </button>
              )}
              <button
                onClick={() => loadBrief(true)}
                disabled={summaryLoading}
                className="btn"
                style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, padding: "4px 10px" }}
              >
                <RefreshCw style={{ width: 12, height: 12, animation: summaryLoading ? "spin 1s linear infinite" : undefined }} />
                {summaryLoading ? "…" : "Regenerate"}
              </button>
            </div>
          </div>

          {summaryLoading ? (
            <BriefSkeleton />
          ) : structured ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {structured.paper && (
                <div style={{ fontSize: 13.5, color: "var(--text)", fontWeight: 500, lineHeight: 1.55 }}>
                  {structured.paper}
                </div>
              )}
              {structured.angleHint && structured.persuasionAngle && (
                <PersuasionCallout angle={structured.persuasionAngle} hint={structured.angleHint} />
              )}
              {structured.mainIdea && (
                <BriefSection
                  label="主要想法"
                  body={structured.mainIdea}
                  onCopy={() => copyToClipboard(structured.mainIdea, "main")}
                  copied={copiedKey === "main"}
                />
              )}
              {structured.coreInnovation && (
                <BriefSection
                  label="核心创新"
                  body={structured.coreInnovation}
                  onCopy={() => copyToClipboard(structured.coreInnovation, "core")}
                  copied={copiedKey === "core"}
                />
              )}
              {structured.questions.length > 0 && (
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <div style={sectionLabel}>可以聊的技术问题</div>
                    <CopyBtn
                      onClick={() => copyToClipboard(structured.questions.map((q, i) => `${i + 1}. ${q}`).join("\n"), "qs")}
                      copied={copiedKey === "qs"}
                    />
                  </div>
                  <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
                    {structured.questions.map((q, i) => (
                      <li key={i} style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
                        <span style={{ display: "flex", alignItems: "flex-start", gap: 6, justifyContent: "space-between" }}>
                          <span>{q}</span>
                          <CopyBtn
                            onClick={() => copyToClipboard(q, `q${i}`)}
                            copied={copiedKey === `q${i}`}
                            subtle
                          />
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {structured.approach && (
                <BriefSection
                  label="怎么切入"
                  body={structured.approach}
                  onCopy={() => copyToClipboard(structured.approach, "approach")}
                  copied={copiedKey === "approach"}
                />
              )}
            </div>
          ) : (
            <div style={{ padding: 16, textAlign: "center" }}>
              <p style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 10 }}>Unable to generate brief</p>
              <button onClick={() => loadBrief(true)} className="btn" style={{ fontSize: 12 }}>
                Try again
              </button>
            </div>
          )}
        </div>

        {/* RIGHT: paper + research context (secondary, renders immediately) */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="section-card" style={{ padding: 16 }}>
            <h3 style={{ fontFamily: "var(--font-heading)", fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
              <FileText style={{ width: 13, height: 13 }} />
              Paper
            </h3>
            <p style={{ fontSize: 13, color: "var(--text)", fontWeight: 600, marginBottom: 6, lineHeight: 1.4 }}>
              {paper.title}
            </p>
            {paper.authors && (
              <p style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginBottom: 10 }}>
                {paper.authors}
              </p>
            )}
            {paper.abstract && (
              <details style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                <summary style={{ cursor: "pointer", color: "var(--text-tertiary)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600, marginBottom: 6 }}>
                  Abstract
                </summary>
                <p style={{ marginTop: 6 }}>{paper.abstract}</p>
              </details>
            )}
          </div>

          {(research.computeLevel || research.directions.length > 0 || research.computeReason) && (
            <div className="section-card" style={{ padding: 16 }}>
              <h3 style={{ fontFamily: "var(--font-heading)", fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                <Cpu style={{ width: 13, height: 13 }} />
                Research Profile
              </h3>
              {research.computeLevel && (
                <div style={{ marginBottom: 10 }}>
                  <p style={profileLabel}>Compute Need</p>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={computeBadgeClass(research.computeLevel)}>
                      {research.computeLevel}
                    </span>
                    {research.computeConfidence != null && (
                      <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                        {Math.round(research.computeConfidence * 100)}% conf
                      </span>
                    )}
                  </div>
                </div>
              )}
              {research.directions.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <p style={profileLabel}>
                    <Compass style={{ width: 11, height: 11, display: "inline", marginRight: 4 }} />
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
              {research.computeReason && (
                <div>
                  <p style={profileLabel}>Why compute matters</p>
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55, margin: 0 }}>
                    {research.computeReason}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
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

      <CopilotButton leadId={brief.id} authorName={brief.personName} />
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

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--blue)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: 6,
};

const profileLabel: React.CSSProperties = {
  fontSize: 10.5,
  color: "var(--text-tertiary)",
  marginBottom: 6,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  fontWeight: 600,
};

function BriefSection({
  label,
  body,
  onCopy,
  copied,
}: {
  label: string;
  body: string;
  onCopy?: () => void;
  copied?: boolean;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ ...sectionLabel, marginBottom: 0 }}>{label}</div>
        {onCopy && <CopyBtn onClick={onCopy} copied={!!copied} subtle />}
      </div>
      <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.65, margin: 0, whiteSpace: "pre-line" }}>{body}</p>
    </div>
  );
}

function CopyBtn({ onClick, copied, subtle }: { onClick: () => void; copied: boolean; subtle?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={copied ? "Copied" : "Copy"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: subtle ? "2px 6px" : "3px 8px",
        fontSize: 10.5,
        color: copied ? "#047857" : "var(--text-tertiary)",
        background: "transparent",
        border: subtle ? "none" : "1px solid var(--border-light)",
        borderRadius: 4,
        cursor: "pointer",
      }}
    >
      {copied ? <Check style={{ width: 11, height: 11 }} /> : <Copy style={{ width: 11, height: 11 }} />}
      {!subtle && (copied ? "Copied" : "Copy")}
    </button>
  );
}

function BriefSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="skeleton" style={{ height: 18, width: "70%", borderRadius: 4 }} />
      <div>
        <div className="skeleton" style={{ height: 11, width: 80, borderRadius: 4, marginBottom: 6 }} />
        <div className="skeleton" style={{ height: 14, width: "100%", borderRadius: 4, marginBottom: 4 }} />
        <div className="skeleton" style={{ height: 14, width: "92%", borderRadius: 4 }} />
      </div>
      <div>
        <div className="skeleton" style={{ height: 11, width: 80, borderRadius: 4, marginBottom: 6 }} />
        <div className="skeleton" style={{ height: 14, width: "100%", borderRadius: 4, marginBottom: 4 }} />
        <div className="skeleton" style={{ height: 14, width: "88%", borderRadius: 4 }} />
      </div>
      <div>
        <div className="skeleton" style={{ height: 11, width: 120, borderRadius: 4, marginBottom: 6 }} />
        <div className="skeleton" style={{ height: 14, width: "95%", borderRadius: 4, marginBottom: 4 }} />
        <div className="skeleton" style={{ height: 14, width: "90%", borderRadius: 4, marginBottom: 4 }} />
        <div className="skeleton" style={{ height: 14, width: "85%", borderRadius: 4 }} />
      </div>
    </div>
  );
}

function briefToPlain(s: {
  paper: string;
  mainIdea: string;
  coreInnovation: string;
  questions: string[];
  approach: string;
}): string {
  return [
    s.paper,
    "",
    `【主要想法】${s.mainIdea}`,
    "",
    `【核心创新】${s.coreInnovation}`,
    "",
    "【可以聊的技术问题】",
    ...s.questions.map((q, i) => `${i + 1}. ${q}`),
    "",
    `【怎么切入】${s.approach}`,
  ].join("\n");
}

const ANGLE_META: Record<"ethos" | "logos" | "pathos", { label: string; emoji: string; bg: string; border: string; color: string; sub: string }> = {
  ethos:  { label: "Ethos",  emoji: "🏛", bg: "#FAF5FF", border: "#E9D5FF", color: "#6B21A8", sub: "权威/背书" },
  logos:  { label: "Logos",  emoji: "📊", bg: "#EFF6FF", border: "#BFDBFE", color: "#1E40AF", sub: "理性/数据" },
  pathos: { label: "Pathos", emoji: "❤️", bg: "#FFF1F2", border: "#FECDD3", color: "#9F1239", sub: "共情/赋能" },
};

function PersuasionCallout({ angle, hint }: { angle: "ethos" | "logos" | "pathos"; hint: string }) {
  const m = ANGLE_META[angle];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "8px 12px",
        background: m.bg,
        border: `1px solid ${m.border}`,
        borderRadius: 8,
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
    >
      <span style={{ fontSize: 16, lineHeight: 1, marginTop: 1 }}>{m.emoji}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 2 }}>
          <span style={{ fontWeight: 600, color: m.color, fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            {m.label}
          </span>
          <span style={{ fontSize: 10.5, color: m.color, opacity: 0.7 }}>{m.sub}</span>
        </div>
        <div style={{ color: "var(--text)" }}>{hint}</div>
      </div>
    </div>
  );
}

/* ── Sales Copilot — floating Ask button + modal Q&A ────────────────── */

interface CopilotMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
}

const SUGGESTED_QUESTIONS = [
  "对方问算力可以挪给学弟学妹用，怎么答？",
  "怎么回应「我已经有 NSF grant 了」这种话？",
  "对方问通过率为什么这么低，怎么解释？",
  "如果对方说他们组没发过 paper 还能申请吗？",
];

function CopilotButton({ leadId, authorName }: { leadId: string; authorName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Sales copilot — 问问题"
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          width: 52,
          height: 52,
          borderRadius: "50%",
          background: "linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%)",
          color: "white",
          border: "none",
          cursor: "pointer",
          boxShadow: "0 8px 24px rgba(59,130,246,0.35)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 40,
          transition: "transform 150ms",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.05)")}
        onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
      >
        <Sparkles style={{ width: 22, height: 22 }} />
      </button>
      {open && <CopilotModal leadId={leadId} authorName={authorName} onClose={() => setOpen(false)} />}
    </>
  );
}

function CopilotModal({
  leadId,
  authorName,
  onClose,
}: {
  leadId: string;
  authorName: string;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setErr(null);
    const next: CopilotMessage[] = [
      ...messages,
      { id: Date.now(), role: "user", text: q },
    ];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const r = await fetch("/api/brief/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId, question: q }),
      });
      const d = await r.json();
      if (!r.ok) {
        setErr(d.error ?? "Failed");
      } else {
        setMessages([...next, { id: Date.now() + 1, role: "assistant", text: d.answer ?? "" }]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (input.trim() && !busy) send(input);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, busy]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "flex-end",
        zIndex: 50,
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, 92vw)",
          height: "min(640px, 80vh)",
          background: "var(--card)",
          borderRadius: 14,
          border: "1px solid var(--border)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 16px",
            borderBottom: "1px solid var(--border-light)",
            background: "linear-gradient(180deg, rgba(59,130,246,0.04) 0%, transparent 100%)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Sparkles style={{ width: 16, height: 16, color: "#3B82F6" }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Sales Copilot</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>关于 {authorName} 的对话助手</div>
            </div>
          </div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{ background: "transparent", border: 0, color: "var(--text-tertiary)", cursor: "pointer", padding: 4, borderRadius: 4, lineHeight: 0 }}
          >
            <X style={{ width: 18, height: 18 }} />
          </button>
        </div>

        {/* messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {messages.length === 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <p style={{ fontSize: 12.5, color: "var(--text-tertiary)", lineHeight: 1.55 }}>
                问一个问题，我会基于这位研究者的 paper 上下文 + 奇绩程序的 facts 给你可以照着说的中文话术。
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    style={{
                      fontSize: 12,
                      textAlign: "left",
                      padding: "8px 10px",
                      background: "var(--bg)",
                      border: "1px solid var(--border-light)",
                      borderRadius: 6,
                      cursor: "pointer",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "85%",
                padding: "8px 12px",
                fontSize: 13,
                lineHeight: 1.55,
                borderRadius: 10,
                background: m.role === "user" ? "#3B82F6" : "var(--bg)",
                color: m.role === "user" ? "white" : "var(--text)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {m.text}
            </div>
          ))}
          {busy && (
            <div style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-tertiary)", padding: "6px 10px" }}>
              <Loader2 style={{ width: 13, height: 13 }} className="spin" />
              thinking…
            </div>
          )}
          {err && (
            <div style={{ alignSelf: "flex-start", padding: "8px 10px", fontSize: 12, color: "#dc2626", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 6 }}>
              {err}
            </div>
          )}
        </div>

        {/* input */}
        <div style={{ padding: 10, borderTop: "1px solid var(--border-light)", display: "flex", gap: 6 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (input.trim() && !busy) send(input);
              }
            }}
            placeholder="问一个问题…  (Enter 发送, Shift+Enter 换行)"
            rows={2}
            style={{
              flex: 1,
              padding: "8px 10px",
              fontSize: 13,
              lineHeight: 1.5,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--card)",
              color: "var(--text)",
              resize: "none",
              boxSizing: "border-box",
              outline: "none",
              fontFamily: "inherit",
            }}
          />
          <button
            onClick={() => send(input)}
            disabled={busy || !input.trim()}
            style={{
              padding: "0 14px",
              background: input.trim() && !busy ? "#3B82F6" : "var(--bg)",
              color: input.trim() && !busy ? "white" : "var(--text-tertiary)",
              border: 0,
              borderRadius: 6,
              cursor: input.trim() && !busy ? "pointer" : "not-allowed",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
            }}
          >
            <Zap style={{ width: 13, height: 13 }} />
            Ask
          </button>
        </div>
      </div>
    </div>
  );
}

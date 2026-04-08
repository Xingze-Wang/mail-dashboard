"use client";

import { useState, useEffect } from "react";
import {
  Search,
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

function computeBadge(level: string | null) {
  switch (level) {
    case "heavy":
      return "bg-red-500/20 text-red-400";
    case "moderate":
      return "bg-yellow-500/20 text-yellow-400";
    case "light":
      return "bg-green-500/20 text-green-400";
    default:
      return "bg-neutral-500/20 text-neutral-400";
  }
}

function statusBadge(status: string) {
  switch (status) {
    case "sent":
      return "bg-green-500/20 text-green-400";
    case "ready":
      return "bg-blue-500/20 text-blue-400";
    case "skipped":
      return "bg-neutral-500/20 text-neutral-400";
    default:
      return "bg-yellow-500/20 text-yellow-400";
  }
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
      className="w-full text-left rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 hover:border-neutral-600 hover:bg-neutral-900 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-white truncate">
              {brief.personName}
            </span>
            {isMismatch && (
              <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] bg-amber-500/20 text-amber-400">
                <AlertTriangle className="h-3 w-3" />
                Co-author
              </span>
            )}
            {brief.outreach.status === "sent" && (
              <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] bg-green-500/20 text-green-400">
                <Send className="h-3 w-3" />
                Emailed
              </span>
            )}
          </div>
          <p className="text-[13px] text-neutral-300 truncate mb-1.5">
            {brief.paper.title}
          </p>
          <div className="flex items-center gap-3 text-[11px] text-neutral-500">
            {brief.research.schoolName && (
              <span className="flex items-center gap-1">
                <GraduationCap className="h-3 w-3" />
                {brief.research.schoolName}
              </span>
            )}
            {brief.research.computeLevel && (
              <span
                className={`rounded px-1.5 py-0.5 ${computeBadge(brief.research.computeLevel)}`}
              >
                {brief.research.computeLevel}
              </span>
            )}
            {brief.paper.publishedAt && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatDate(brief.paper.publishedAt)}
              </span>
            )}
          </div>
        </div>
        <div className="text-neutral-600 mt-1">
          <FileText className="h-4 w-4" />
        </div>
      </div>
      {isMismatch && (
        <p className="mt-2 text-[11px] text-amber-400/80 leading-relaxed">
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
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-[13px] text-neutral-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to results
        </button>

        {wechatMarked ? (
          <span className="rounded-full bg-green-500/20 px-3 py-1 text-[12px] text-green-400 font-medium">
            Added on WeChat
          </span>
        ) : (
          <button
            onClick={markWechat}
            disabled={wechatSaving}
            className="rounded-lg bg-green-600 px-4 py-1.5 text-[12px] font-medium text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
          >
            {wechatSaving ? "Saving..." : "Mark: Added on WeChat"}
          </button>
        )}
      </div>

      {/* AI Summary — the main thing sales reads */}
      <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-5">
        <h3 className="text-[13px] font-semibold text-blue-300 mb-3">
          Sales Brief
        </h3>
        {summaryLoading ? (
          <p className="text-[13px] text-neutral-500 animate-pulse">
            Generating brief...
          </p>
        ) : summary ? (
          <p className="text-[13px] text-neutral-200 leading-relaxed whitespace-pre-line">
            {summary}
          </p>
        ) : (
          <p className="text-[12px] text-neutral-500">
            Unable to generate summary
          </p>
        )}
      </div>

      {/* Header */}
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white mb-1">
              {brief.personName}
            </h2>
            {research.schoolName && (
              <div className="flex items-center gap-2 text-[13px] text-neutral-400 mb-2">
                <GraduationCap className="h-3.5 w-3.5" />
                {research.schoolName}
                {tierLabel(research.schoolTier) && (
                  <span className="text-neutral-600">
                    ({tierLabel(research.schoolTier)})
                  </span>
                )}
              </div>
            )}
          </div>
          {paper.pdfUrl && (
            <a
              href={paper.pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-md bg-neutral-800 px-3 py-1.5 text-[12px] text-neutral-300 hover:bg-neutral-700 transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              PDF
            </a>
          )}
        </div>
      </div>

      {/* Author mismatch warning */}
      {authorMismatch && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-[13px] font-medium text-amber-300 mb-1">
                Author Mismatch
              </p>
              <p className="text-[12px] text-amber-400/80 leading-relaxed">
                {authorMismatch.note}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Paper info */}
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
        <h3 className="text-[13px] font-semibold text-neutral-300 mb-3 flex items-center gap-2">
          <FileText className="h-3.5 w-3.5" />
          Paper
        </h3>
        <p className="text-[14px] text-white font-medium mb-2">
          {paper.title}
        </p>
        <p className="text-[12px] text-neutral-500 mb-3">
          {paper.authors}
        </p>
        {paper.abstract && (
          <p className="text-[12px] text-neutral-400 leading-relaxed">
            {paper.abstract.length > 600
              ? paper.abstract.slice(0, 600) + "..."
              : paper.abstract}
          </p>
        )}
      </div>

      {/* Research profile */}
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
        <h3 className="text-[13px] font-semibold text-neutral-300 mb-3 flex items-center gap-2">
          <Cpu className="h-3.5 w-3.5" />
          Research Profile
        </h3>
        <div className="grid grid-cols-2 gap-4">
          {research.computeLevel && (
            <div>
              <p className="text-[11px] text-neutral-500 mb-1">Compute Need</p>
              <span
                className={`inline-block rounded px-2 py-0.5 text-[12px] font-medium ${computeBadge(research.computeLevel)}`}
              >
                {research.computeLevel}
              </span>
              {research.computeConfidence != null && (
                <span className="ml-2 text-[11px] text-neutral-600">
                  {Math.round(research.computeConfidence * 100)}% conf
                </span>
              )}
            </div>
          )}
          {research.directions.length > 0 && (
            <div>
              <p className="text-[11px] text-neutral-500 mb-1">
                <Compass className="h-3 w-3 inline mr-1" />
                Directions
              </p>
              <div className="flex flex-wrap gap-1">
                {research.directions.map((d) => (
                  <span
                    key={d}
                    className="rounded px-1.5 py-0.5 text-[11px] bg-blue-500/15 text-blue-400"
                  >
                    {d}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
        {research.computeReason && (
          <p className="mt-3 text-[12px] text-neutral-400 leading-relaxed">
            {research.computeReason}
          </p>
        )}
      </div>

      {/* Outreach status */}
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
        <h3 className="text-[13px] font-semibold text-neutral-300 mb-3 flex items-center gap-2">
          <Mail className="h-3.5 w-3.5" />
          Outreach
        </h3>
        <div className="space-y-2 text-[12px]">
          <div className="flex items-center justify-between">
            <span className="text-neutral-500">Emailed to</span>
            <span className="text-neutral-300">{outreach.emailedTo}</span>
          </div>
          {outreach.emailedName && (
            <div className="flex items-center justify-between">
              <span className="text-neutral-500">Contact name</span>
              <span className="text-neutral-300">{outreach.emailedName}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-neutral-500">Status</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${statusBadge(outreach.status)}`}
            >
              {outreach.status}
            </span>
          </div>
          {outreach.sentAt && (
            <div className="flex items-center justify-between">
              <span className="text-neutral-500">Sent at</span>
              <span className="text-neutral-300">
                {formatDate(outreach.sentAt)}
              </span>
            </div>
          )}
          {outreach.subject && (
            <div className="pt-2 border-t border-neutral-800">
              <p className="text-neutral-500 mb-1">Subject</p>
              <p className="text-neutral-300">{outreach.subject}</p>
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

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-white flex items-center gap-2 mb-1">
          <User className="h-5 w-5" />
          Sales Brief
        </h1>
        <p className="text-[13px] text-neutral-500">
          Type a name to look up who they are, what paper, and what we sent.
        </p>
      </div>

      {/* Search */}
      {!selected && (
        <form onSubmit={handleSearch} className="mb-6">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Enter first name, e.g. Jiahao"
                className="w-full rounded-lg border border-neutral-800 bg-neutral-900 py-2.5 pl-10 pr-4 text-[13px] text-white placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600 transition-colors"
                autoFocus
              />
            </div>
            <button
              type="submit"
              disabled={loading || query.trim().length < 2}
              className="rounded-lg bg-white px-5 py-2.5 text-[13px] font-medium text-black hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? "Searching..." : "Search"}
            </button>
          </div>
        </form>
      )}

      {/* Results */}
      {selected ? (
        <DetailView
          brief={selected}
          onBack={() => setSelected(null)}
        />
      ) : results !== null ? (
        results.length === 0 ? (
          <div className="text-center py-12">
            <User className="h-8 w-8 text-neutral-700 mx-auto mb-3" />
            <p className="text-[13px] text-neutral-500">
              No matches found for &ldquo;{query}&rdquo;
            </p>
            <p className="text-[11px] text-neutral-600 mt-1">
              Try a different spelling or check the pipeline
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-[12px] text-neutral-500 mb-3">
              {results.length} result{results.length !== 1 && "s"} for &ldquo;{query}&rdquo;
            </p>
            {results.map((b) => (
              <ResultCard
                key={b.id}
                brief={b}
                onSelect={() => setSelected(b)}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

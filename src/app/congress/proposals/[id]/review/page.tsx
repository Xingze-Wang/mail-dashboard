"use client";

// /congress/proposals/[id]/review
//
// Real proposal review — replaces /congress/discuss's synthetic sandbox.
// Shows what congress actually proposed for THIS template, the
// hypothesis it came from, and lets admin leave inline feedback that
// flows back into next week's evidence pack.

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, ArrowLeft, MessageSquare, Sparkles } from "lucide-react";

interface Proposal {
  id: string;
  name: string;
  status: string;
  segment_default: string | null;
  proposed_by: string | null;
  proposed_reason: string | null;
  proposed_evidence: {
    slot_swapped?: string;
    what_changed?: string;
    hypothesis_id?: string;
    expected_pitfall?: string;
    baseline_template_id?: string;
    editor_tone_assessment?: string;
  } | null;
  subject_format?: string;
  intro_prompt?: string;
  greeting_format?: string;
  rep_intro_format?: string;
  school_pitch_format?: string;
  cta_signoff_format?: string;
  created_at: string;
}

interface Hypothesis {
  id: string;
  hypothesis: string;
  reasoning: string;
  segment: Record<string, unknown>;
  status: string;
  generated_at: string;
}

interface FeedbackRow {
  id: string;
  body: string;
  author_name: string;
  created_at: string;
  revision_run_id: string | null;
}

interface ReviewData {
  proposal: Proposal;
  hypothesis: Hypothesis | null;
  baseline: Proposal | null;
  feedback: FeedbackRow[];
  swapped_slot: string | null;
}

const SLOT_LABEL: Record<string, string> = {
  subject_format: "Subject",
  greeting_format: "Greeting",
  intro_prompt: "Intro (LLM)",
  rep_intro_format: "Rep intro",
  school_pitch_format: "School pitch",
  cta_signoff_format: "CTA / sign-off",
};

export default function ProposalReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [feedbackText, setFeedbackText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/congress/proposals/${id}/review`, { credentials: "include" });
      if (r.status === 401) { router.replace("/login?next=/congress/proposals/" + id + "/review"); return; }
      if (!r.ok) { setMsg(`Failed (${r.status})`); return; }
      setData(await r.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  const submit = async (revise: boolean) => {
    if (feedbackText.trim().length < 10) {
      setMsg("≥10 chars required — be specific about what should change.");
      return;
    }
    setSubmitting(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/congress/proposals/${id}/review/feedback`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: feedbackText.trim(), revise }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg(`Failed: ${j.error ?? r.status}`);
        return;
      }
      setFeedbackText("");
      setMsg(revise ? "Feedback saved; revise will run on the next congress cycle." : "Feedback saved.");
      await load();
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-16 text-center"><Loader2 className="inline h-5 w-5 animate-spin" /></div>;
  if (!data) return <div className="p-8 text-sm text-red-700">{msg ?? "Not found."}</div>;

  const ev = data.proposal.proposed_evidence;
  const swapped = data.swapped_slot;

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 32px" }}>
      <Link href="/templates" style={{ fontSize: 12, color: "var(--blue, #2563eb)", display: "inline-flex", alignItems: "center", gap: 4, marginBottom: 14 }}>
        <ArrowLeft className="h-3.5 w-3.5" /> Back to templates
      </Link>

      <h1 className="page-title" style={{ fontSize: 22, fontWeight: 600 }}>
        Reviewing proposal
      </h1>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontFamily: "monospace", marginBottom: 18 }}>
        {data.proposal.name}
      </div>

      {/* What congress saw — the hypothesis it was reasoning about */}
      {data.hypothesis ? (
        <section style={{ marginBottom: 24, padding: "14px 18px", background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#92400e", marginBottom: 6 }}>
            Hypothesis · {data.hypothesis.status}
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.65, color: "#451a03", marginBottom: 8 }}>
            {data.hypothesis.hypothesis}
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.6, color: "#78350f", whiteSpace: "pre-wrap" }}>
            <span style={{ fontWeight: 600 }}>Reasoning:</span> {data.hypothesis.reasoning}
          </div>
          {data.hypothesis.segment && Object.keys(data.hypothesis.segment).length > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: "#78350f" }}>
              <span style={{ fontWeight: 600 }}>Segment:</span> <code>{JSON.stringify(data.hypothesis.segment)}</code>
            </div>
          )}
        </section>
      ) : (
        <section style={{ marginBottom: 24, padding: "10px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12, color: "var(--text-tertiary)" }}>
          No hypothesis linked. This proposal may have been generated outside the hypothesis-driven path (e.g. manual congress run).
        </section>
      )}

      {/* What congress proposed — show the labeled email, swapped slot highlighted */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, color: "var(--text-primary)" }}>
          The proposal
        </h2>
        <div style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 8, padding: "16px 18px" }}>
          {(["subject_format", "greeting_format", "intro_prompt", "rep_intro_format", "school_pitch_format", "cta_signoff_format"] as const).map((key) => {
            const text = data.proposal[key];
            if (!text) return null;
            const isSwapped = swapped === key;
            return (
              <div key={key} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 14, marginBottom: 14, alignItems: "start" }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: isSwapped ? "#a16207" : "#94a3b8", textAlign: "right", paddingTop: 4 }}>
                  {SLOT_LABEL[key]}
                  {isSwapped && <div style={{ marginTop: 2 }}>· changed</div>}
                </div>
                <div style={{ whiteSpace: "pre-wrap", padding: isSwapped ? "10px 12px" : 0, background: isSwapped ? "#fefce8" : "transparent", borderLeft: isSwapped ? "3px solid #fde68a" : "none", borderRadius: isSwapped ? 4 : 0, fontSize: 14, lineHeight: 1.7, color: "#1f2937" }}>
                  {text}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Congress's reasoning — proposed_reason, expected_pitfall, editor */}
      {(data.proposal.proposed_reason || ev?.expected_pitfall || ev?.editor_tone_assessment) && (
        <section style={{ marginBottom: 24, padding: "14px 18px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#1e40af", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <Sparkles className="h-3 w-3" />
            Congress reasoning
          </div>
          {data.proposal.proposed_reason && (
            <div style={{ fontSize: 13, lineHeight: 1.65, color: "#1e3a8a", whiteSpace: "pre-wrap", marginBottom: ev?.expected_pitfall ? 10 : 0 }}>
              {data.proposal.proposed_reason}
            </div>
          )}
          {ev?.expected_pitfall && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#7f1d1d", padding: "8px 10px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6 }}>
              <span style={{ fontWeight: 700 }}>Expected pitfall:</span> {ev.expected_pitfall}
            </div>
          )}
          {ev?.editor_tone_assessment && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#374151", fontStyle: "italic" }}>
              Editor: {ev.editor_tone_assessment}
            </div>
          )}
        </section>
      )}

      {/* Inline feedback thread */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
          <MessageSquare className="h-4 w-4" /> Feedback ({data.feedback.length})
        </h2>
        {data.feedback.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
            {data.feedback.map((f) => (
              <div key={f.id} style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 6, padding: "10px 12px" }}>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 600 }}>{f.author_name}</span>
                  <span>{new Date(f.created_at).toLocaleString()}</span>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", color: "#1f2937" }}>{f.body}</div>
                {f.revision_run_id && (
                  <div style={{ fontSize: 11, marginTop: 4, color: "#1d4ed8" }}>
                    → triggered revise run <code>{f.revision_run_id.slice(0, 8)}</code>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <div style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: 12, background: "white" }}>
          <textarea
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            placeholder="What should congress change? Be specific — this feeds next Monday's evidence pack."
            rows={4}
            disabled={submitting}
            style={{ width: "100%", fontSize: 13, lineHeight: 1.6, padding: 8, border: "1px solid #e2e8f0", borderRadius: 6, resize: "vertical", fontFamily: "inherit" }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
            <button
              onClick={() => void submit(false)}
              disabled={submitting || feedbackText.trim().length < 10}
              style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, background: "#1e293b", color: "white", border: "none", cursor: "pointer", opacity: submitting || feedbackText.trim().length < 10 ? 0.5 : 1 }}
            >
              {submitting ? "Saving…" : "Save comment"}
            </button>
            <button
              onClick={() => void submit(true)}
              disabled={submitting || feedbackText.trim().length < 10}
              style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, background: "#dbeafe", color: "#1e40af", border: "1px solid #93c5fd", cursor: "pointer", opacity: submitting || feedbackText.trim().length < 10 ? 0.5 : 1 }}
              title="Save + flag for revise on next congress cycle"
            >
              Save & ask congress to revise
            </button>
            {msg && (
              <span style={{ fontSize: 11, marginLeft: "auto", color: msg.startsWith("Failed") || msg.includes("required") ? "#b91c1c" : "#047857" }}>
                {msg}
              </span>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

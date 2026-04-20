import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { resolveCategory } from "@/lib/assignment";

/**
 * GET /api/scorer/live
 *
 * Live analytics on the scorer's actual behavior in production — not the
 * training-set metrics (those live at /api/scorer).
 *
 * Returns:
 *   - distribution  : current score buckets across all pipeline_leads
 *   - calibration   : for each bucket, what % of sent leads resulted in
 *                     a WeChat conversion — i.e. does the score predict
 *                     real outcomes?
 *   - topPending    : the 10 highest-scored leads still 'ready' — an
 *                     action queue for sales.
 *   - bigMisses     : sent but bounced/no-reply despite a high score.
 *   - hiddenWins    : low-scored leads that converted anyway — training
 *                     signal for the next round of retraining.
 *   - byCategory    : per-category mean score + count + conversion rate.
 *   - sourceBreakdown : Python-trained-classifier vs Gemini-fallback
 *                     coverage, so admin can spot drift.
 */
export async function GET() {
  const { data: leads, error } = await supabase
    .from("pipeline_leads")
    .select(
      "id, title, author_email, status, lead_tier, local_score, citation_count, matched_directions, assigned_rep_id, source, created_at, sent_at",
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = leads ?? [];

  // WeChat conversions to compute outcome → score calibration.
  const { data: wechatRaw } = await supabase
    .from("brief_lookups")
    .select("query")
    .eq("added_wechat", true);
  const wechatEmails = new Set(
    (wechatRaw ?? [])
      .map((w) => (w.query as string | null)?.toLowerCase())
      .filter(Boolean) as string[],
  );

  // ── Distribution across current leads (not training snapshot) ──
  const buckets = Array.from({ length: 20 }, (_, i) => ({
    bin: `${(i * 0.05).toFixed(2)}-${((i + 1) * 0.05).toFixed(2)}`,
    min: i * 0.05,
    max: (i + 1) * 0.05,
    count: 0,
    sent: 0,
    converted: 0,
  }));

  const scored = rows.filter((l) => typeof l.local_score === "number");

  for (const lead of scored) {
    const s = lead.local_score as number;
    const idx = Math.min(19, Math.floor(s * 20));
    const bucket = buckets[idx];
    bucket.count++;
    const sentStatus = lead.status === "sent" || lead.status === "replied" || lead.status === "wechat_added";
    if (sentStatus) bucket.sent++;
    if (wechatEmails.has((lead.author_email as string | null)?.toLowerCase() ?? "")) bucket.converted++;
  }

  // Collapse to 10 bins for display; keep 20-bin precision for calibration math.
  const distribution = Array.from({ length: 10 }, (_, i) => {
    const a = buckets[i * 2];
    const b = buckets[i * 2 + 1];
    return {
      bin: `${(i * 0.1).toFixed(1)}-${((i + 1) * 0.1).toFixed(1)}`,
      count: a.count + b.count,
    };
  });

  const calibration = Array.from({ length: 10 }, (_, i) => {
    const a = buckets[i * 2];
    const b = buckets[i * 2 + 1];
    const sent = a.sent + b.sent;
    const conv = a.converted + b.converted;
    return {
      bin: `${(i * 0.1).toFixed(1)}-${((i + 1) * 0.1).toFixed(1)}`,
      sent,
      converted: conv,
      convRate: sent > 0 ? Math.round((conv / sent) * 1000) / 10 : 0,
    };
  });

  // ── Top-scored pending leads (still ready, unsent) ──
  const topPending = scored
    .filter((l) => l.status === "ready")
    .sort((a, b) => (b.local_score as number) - (a.local_score as number))
    .slice(0, 10)
    .map((l) => ({
      id: l.id,
      title: (l.title as string)?.slice(0, 100) ?? "(untitled)",
      score: l.local_score,
      tier: l.lead_tier,
      citations: l.citation_count,
    }));

  // ── Misses: high score (> 0.7) but sent with no positive outcome ──
  const bigMisses = scored
    .filter((l) => {
      const s = l.local_score as number;
      const ended = l.status === "sent";
      const email = (l.author_email as string | null)?.toLowerCase() ?? "";
      return s > 0.7 && ended && !wechatEmails.has(email);
    })
    .sort((a, b) => (b.local_score as number) - (a.local_score as number))
    .slice(0, 8)
    .map((l) => ({
      id: l.id,
      title: (l.title as string)?.slice(0, 100) ?? "(untitled)",
      score: l.local_score,
      sentAt: l.sent_at,
    }));

  // ── Hidden wins: low score (< 0.4) but converted ──
  const hiddenWins = scored
    .filter((l) => {
      const s = l.local_score as number;
      const email = (l.author_email as string | null)?.toLowerCase() ?? "";
      return s < 0.4 && wechatEmails.has(email);
    })
    .sort((a, b) => (a.local_score as number) - (b.local_score as number))
    .slice(0, 8)
    .map((l) => ({
      id: l.id,
      title: (l.title as string)?.slice(0, 100) ?? "(untitled)",
      score: l.local_score,
    }));

  // ── By category: mean score + count + conv rate ──
  const catMap = new Map<
    string,
    { scores: number[]; sent: number; converted: number }
  >();
  for (const lead of scored) {
    const cat = resolveCategory(lead.matched_directions ?? null) ?? "(unmatched)";
    const entry = catMap.get(cat) ?? { scores: [], sent: 0, converted: 0 };
    entry.scores.push(lead.local_score as number);
    if (lead.status === "sent" || lead.status === "replied" || lead.status === "wechat_added") entry.sent++;
    if (wechatEmails.has((lead.author_email as string | null)?.toLowerCase() ?? "")) entry.converted++;
    catMap.set(cat, entry);
  }
  const byCategory = Array.from(catMap.entries())
    .map(([name, s]) => ({
      name,
      count: s.scores.length,
      meanScore: s.scores.length > 0
        ? Math.round((s.scores.reduce((a, b) => a + b, 0) / s.scores.length) * 100) / 100
        : 0,
      sent: s.sent,
      converted: s.converted,
      convRate: s.sent > 0 ? Math.round((s.converted / s.sent) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  // ── Source coverage: Python-trained vs Gemini-fallback ──
  // Heuristic: python_scanner source → trained classifier path, else Gemini fallback.
  let pythonScored = 0;
  let apiScored = 0;
  let unscored = 0;
  for (const lead of rows) {
    if (typeof lead.local_score !== "number") { unscored++; continue; }
    if (lead.source === "python_scanner") pythonScored++;
    else apiScored++;
  }

  return NextResponse.json({
    totalLeads: rows.length,
    scoredLeads: scored.length,
    meanScore: scored.length > 0
      ? Math.round((scored.reduce((a, l) => a + (l.local_score as number), 0) / scored.length) * 100) / 100
      : 0,
    distribution,
    calibration,
    topPending,
    bigMisses,
    hiddenWins,
    byCategory,
    sourceBreakdown: { pythonScored, apiScored, unscored },
  });
}

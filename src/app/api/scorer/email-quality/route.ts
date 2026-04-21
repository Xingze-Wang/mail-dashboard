import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { judgeIntro } from "@/lib/bench-judge";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * GET /api/scorer/email-quality
 *
 * Returns aggregate stats on email quality — pulled from pipeline_leads rows
 * that already have judge_verdicts (populated by /api/drift/rejudge or during
 * live judging). Cheap read, no new LLM calls.
 *
 * POST /api/scorer/email-quality
 * Body: { sampleSize?: number }  (default 10)
 *
 * Re-judges the {sampleSize} most recent unjudged sent leads and persists
 * verdicts so the GET aggregate reflects reality. Rate-limited to sampleSize
 * <= 30 to stay under Vercel's 300s limit.
 */

interface JudgeVerdict {
  judge: string;
  score_0_10: number;
  reasons: string;
  prompt_leak: boolean;
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data, error } = await supabase
    .from("pipeline_leads")
    .select(
      "id, title, draft_model, draft_edit_distance, judge_avg, judge_prompt_leak, judge_at, judge_verdicts, sent_at",
    )
    .eq("status", "sent")
    .not("judge_avg", "is", null)
    .order("sent_at", { ascending: false })
    .limit(500);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = data ?? [];

  // Per-judge mean score + leak rate, across all judged rows.
  const perJudge: Record<string, { sum: number; n: number; leaks: number }> = {};
  for (const r of rows) {
    const verdicts = (r.judge_verdicts as JudgeVerdict[] | null) ?? [];
    for (const v of verdicts) {
      if (!perJudge[v.judge]) perJudge[v.judge] = { sum: 0, n: 0, leaks: 0 };
      perJudge[v.judge].sum += v.score_0_10;
      perJudge[v.judge].n += 1;
      if (v.prompt_leak) perJudge[v.judge].leaks += 1;
    }
  }
  const byJudge = Object.entries(perJudge).map(([judge, s]) => ({
    judge,
    meanScore: s.n > 0 ? Math.round((s.sum / s.n) * 10) / 10 : 0,
    leakRate: s.n > 0 ? Math.round((s.leaks / s.n) * 1000) / 10 : 0,
    n: s.n,
  }));

  // Trend: mean judge_avg per week over last 8 weeks.
  const WEEKS = 8;
  const weeks: { week: string; meanScore: number; leakRate: number; n: number }[] = [];
  const now = Date.now();
  for (let i = WEEKS - 1; i >= 0; i--) {
    const start = now - (i + 1) * 7 * 86_400_000;
    const end = now - i * 7 * 86_400_000;
    const inWeek = rows.filter((r) => {
      const t = r.sent_at ? Date.parse(r.sent_at) : 0;
      return t >= start && t < end;
    });
    const scored = inWeek.filter((r) => typeof r.judge_avg === "number");
    const leaks = inWeek.filter((r) => r.judge_prompt_leak === true).length;
    weeks.push({
      week: new Date(end).toISOString().slice(0, 10),
      meanScore:
        scored.length > 0
          ? Math.round((scored.reduce((a, r) => a + (r.judge_avg as number), 0) / scored.length) * 10) / 10
          : 0,
      leakRate: inWeek.length > 0 ? Math.round((leaks / inWeek.length) * 1000) / 10 : 0,
      n: inWeek.length,
    });
  }

  // Distribution (0-10 buckets, half-point steps).
  const dist = Array.from({ length: 20 }, (_, i) => ({
    bin: `${(i * 0.5).toFixed(1)}`,
    count: 0,
  }));
  for (const r of rows) {
    const s = r.judge_avg as number;
    const idx = Math.min(19, Math.max(0, Math.floor(s * 2)));
    dist[idx].count += 1;
  }

  // Judge vs sales-edit agreement buckets (same buckets as /drift UI but
  // trimmed to just the counts here — the detailed list lives in /drift).
  const JUDGE_HIGH = 7, JUDGE_LOW = 5, EDIT_HEAVY = 200, EDIT_LIGHT = 50;
  let jLovedSHated = 0, jHatedSKept = 0, bothLoved = 0, bothHated = 0, middle = 0;
  for (const r of rows) {
    const j = r.judge_avg as number;
    const d = r.draft_edit_distance as number | null;
    if (d === null || d === undefined) continue;
    if (j >= JUDGE_HIGH && d >= EDIT_HEAVY) jLovedSHated++;
    else if (j < JUDGE_LOW && d < EDIT_LIGHT) jHatedSKept++;
    else if (j >= JUDGE_HIGH && d < EDIT_LIGHT) bothLoved++;
    else if (j < JUDGE_LOW && d >= EDIT_HEAVY) bothHated++;
    else middle++;
  }

  // Unjudged backlog — what a rejudge POST would bite into.
  const { count: unjudgedCount } = await supabase
    .from("pipeline_leads")
    .select("*", { count: "exact", head: true })
    .eq("status", "sent")
    .is("judge_avg", null)
    .not("draft_original_html", "is", null);

  return NextResponse.json({
    totalJudged: rows.length,
    meanScore:
      rows.length > 0
        ? Math.round((rows.reduce((a, r) => a + (r.judge_avg as number), 0) / rows.length) * 10) / 10
        : 0,
    leakRate:
      rows.length > 0
        ? Math.round((rows.filter((r) => r.judge_prompt_leak).length / rows.length) * 1000) / 10
        : 0,
    byJudge,
    weeks,
    distribution: dist,
    agreement: { jLovedSHated, jHatedSKept, bothLoved, bothHated, middle },
    unjudged: unjudgedCount ?? 0,
  });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const sampleSize = Math.min(30, Math.max(1, Number(body.sampleSize ?? 10)));

  const { data: candidates, error } = await supabase
    .from("pipeline_leads")
    .select("id, title, abstract, draft_original_html, draft_model")
    .eq("status", "sent")
    .is("judge_avg", null)
    .not("draft_original_html", "is", null)
    .order("sent_at", { ascending: false })
    .limit(sampleSize);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const leads = candidates ?? [];
  if (leads.length === 0) {
    return NextResponse.json({ judged: 0, skipped: 0, reason: "no unjudged sent leads" });
  }

  let judged = 0;
  let errored = 0;
  for (const lead of leads) {
    try {
      const verdicts = await judgeIntro(
        String(lead.title ?? ""),
        String(lead.abstract ?? "").slice(0, 1500),
        String(lead.draft_model ?? "unknown"),
        stripHtml(String(lead.draft_original_html ?? "")).slice(0, 2000),
      );
      const valid = verdicts.filter((v) => v.error === null);
      const avg = valid.length > 0 ? valid.reduce((s, v) => s + v.score_0_10, 0) / valid.length : null;
      const anyLeak = verdicts.some((v) => v.prompt_leak);
      await supabase
        .from("pipeline_leads")
        .update({
          judge_verdicts: verdicts,
          judge_avg: avg,
          judge_prompt_leak: anyLeak,
          judge_at: new Date().toISOString(),
        })
        .eq("id", lead.id);
      judged++;
    } catch {
      errored++;
    }
  }

  return NextResponse.json({ judged, errored, totalAttempted: leads.length });
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

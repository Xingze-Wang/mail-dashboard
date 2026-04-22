import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/drift/disagreement
 *
 * Pulls sent leads that have BOTH a judge score and a meaningful sales-edit
 * signal, then buckets them into 4 quadrants based on agreement between the
 * two. The quadrants where they disagree are the ones the rubric needs to
 * learn from.
 *
 * Bucketing thresholds (tune as we get more data):
 *   judge_high  ≥ 7   (out of 10)
 *   judge_low   < 5
 *   edit_heavy  ≥ 200 (char-bag distance, ~"rewrote half a paragraph")
 *   edit_light  < 50
 */
const JUDGE_HIGH = 7;
const JUDGE_LOW = 5;
const EDIT_HEAVY = 200;
const EDIT_LIGHT = 50;

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data, error } = await supabase
    .from("pipeline_leads")
    .select("id, title, draft_original_html, draft_html, draft_edit_distance, edit_reasons, edit_note, judge_avg, judge_prompt_leak, judge_at, judge_verdicts, sent_at, draft_model")
    .eq("status", "sent")
    .not("judge_avg", "is", null)
    .not("draft_edit_distance", "is", null)
    .order("sent_at", { ascending: false })
    .limit(500);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const judgeLovedSalesHated: typeof rows = [];
  const judgeHatedSalesKept: typeof rows = [];
  const bothLoved: typeof rows = [];
  const bothHated: typeof rows = [];
  const middle: typeof rows = [];

  for (const r of rows) {
    const j = r.judge_avg as number;
    const d = r.draft_edit_distance as number;
    if (j >= JUDGE_HIGH && d >= EDIT_HEAVY) judgeLovedSalesHated.push(r);
    else if (j < JUDGE_LOW && d < EDIT_LIGHT) judgeHatedSalesKept.push(r);
    else if (j >= JUDGE_HIGH && d < EDIT_LIGHT) bothLoved.push(r);
    else if (j < JUDGE_LOW && d >= EDIT_HEAVY) bothHated.push(r);
    else middle.push(r);
  }

  return NextResponse.json({
    thresholds: { JUDGE_HIGH, JUDGE_LOW, EDIT_HEAVY, EDIT_LIGHT },
    quadrants: {
      judgeLovedSalesHated: judgeLovedSalesHated.slice(0, 50),
      judgeHatedSalesKept: judgeHatedSalesKept.slice(0, 50),
      bothLoved: bothLoved.slice(0, 20),
      bothHated: bothHated.slice(0, 20),
    },
    counts: {
      judgeLovedSalesHated: judgeLovedSalesHated.length,
      judgeHatedSalesKept: judgeHatedSalesKept.length,
      bothLoved: bothLoved.length,
      bothHated: bothHated.length,
      middle: middle.length,
      total: rows.length,
    },
  });
}

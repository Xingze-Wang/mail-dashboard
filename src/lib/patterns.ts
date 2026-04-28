// Pattern mining + storage.
//
// Walks the runAnalysis() output, picks bucket findings that are
// (a) high-N enough to trust and (b) lifted enough to be interesting,
// then stores them as durable "patterns" the helper can pull from.
//
// Storage shape (table `patterns` — see migrations/021):
//   id           uuid pk
//   scope_rep_id int|null    -- null = org-wide pattern
//   dimension    text
//   bucket       text
//   sent         int
//   wechat       int
//   replied      int
//   wechat_rate  float
//   reply_rate   float
//   wechat_lift  float       -- vs scope baseline
//   reply_lift   float
//   summary      text        -- human-readable one-liner
//   computed_at  timestamptz
//
// Refresh policy: for each (scope_rep_id, dimension), DELETE existing
// rows then INSERT current ones. Idempotent.

import { supabase } from "@/lib/db";
import { runAnalysis, type AnalysisResult } from "@/lib/analysis";

export interface Pattern {
  scope_rep_id: number | null;
  dimension: string;
  bucket: string;
  sent: number;
  wechat: number;
  replied: number;
  wechat_rate: number;
  reply_rate: number;
  wechat_lift: number;
  reply_lift: number;
  summary: string;
}

const MIN_LIFT = 1.5;        // bucket must outperform baseline by 50%
const MIN_DOWN_LIFT = 0.5;   // OR underperform by 50% (also notable)
const MIN_SENT = 10;         // bucket must have at least 10 sends

function mkSummary(scopeLabel: string, dim: string, bucket: string, lift: number, rate: number, n: number, kind: "wechat" | "reply"): string {
  const direction = lift >= 1 ? "outperforms" : "underperforms";
  const liftPct = Math.abs(lift - 1) * 100;
  const ratePct = (rate * 100).toFixed(1);
  return `${scopeLabel}: in '${dim}' = "${bucket}", ${kind} rate is ${ratePct}% (${direction} baseline by ${liftPct.toFixed(0)}%, n=${n})`;
}

/** Mine patterns from one analysis result. */
export function minePatterns(analysis: AnalysisResult, scopeLabel: string): Pattern[] {
  const out: Pattern[] = [];
  const repId = analysis.scope.repId ?? null;

  for (const dim of analysis.dimensions) {
    for (const b of dim.buckets) {
      if (b.sent < MIN_SENT) continue;
      const wechatLift = analysis.baselineWechatRate > 0 ? b.wechatRate / analysis.baselineWechatRate : 0;
      const replyLift = analysis.baselineReplyRate > 0 ? b.replyRate / analysis.baselineReplyRate : 0;

      const wechatNotable = Number.isFinite(wechatLift) && (wechatLift >= MIN_LIFT || (wechatLift > 0 && wechatLift <= MIN_DOWN_LIFT));
      const replyNotable = Number.isFinite(replyLift) && (replyLift >= MIN_LIFT || (replyLift > 0 && replyLift <= MIN_DOWN_LIFT));
      if (!wechatNotable && !replyNotable) continue;

      // One-liner: prefer wechat lift if both fire.
      const summary = wechatNotable
        ? mkSummary(scopeLabel, dim.label, b.bucket, wechatLift, b.wechatRate, b.sent, "wechat")
        : mkSummary(scopeLabel, dim.label, b.bucket, replyLift, b.replyRate, b.sent, "reply");

      out.push({
        scope_rep_id: repId,
        dimension: dim.dimension,
        bucket: b.bucket,
        sent: b.sent,
        wechat: b.wechat,
        replied: b.replied,
        wechat_rate: Number.isFinite(b.wechatRate) ? b.wechatRate : 0,
        reply_rate: Number.isFinite(b.replyRate) ? b.replyRate : 0,
        wechat_lift: Number.isFinite(wechatLift) ? wechatLift : 0,
        reply_lift: Number.isFinite(replyLift) ? replyLift : 0,
        summary,
      });
    }
  }

  return out;
}

/** Refresh patterns for the given scope: org-wide if repId=null, per-rep otherwise. */
export async function refreshPatterns(repId: number | null, scopeLabel: string): Promise<Pattern[]> {
  const analysis = await runAnalysis({ repId, lookbackDays: null });
  const patterns = minePatterns(analysis, scopeLabel);

  // Wipe-then-write per scope. Cheap at our scale.
  const del = await supabase.from("patterns").delete().eq("scope_rep_id", repId ?? -1);
  // Supabase treats null specially in eq(); use a sentinel for org-wide.
  if (repId === null) {
    await supabase.from("patterns").delete().is("scope_rep_id", null);
  }
  if (del.error) {
    // Likely table missing — surface but don't crash.
    console.warn("patterns delete failed (table may not exist yet):", del.error.message);
  }

  if (patterns.length === 0) return [];

  const rows = patterns.map((p) => ({
    scope_rep_id: p.scope_rep_id,
    dimension: p.dimension,
    bucket: p.bucket,
    sent: p.sent,
    wechat: p.wechat,
    replied: p.replied,
    wechat_rate: p.wechat_rate,
    reply_rate: p.reply_rate,
    wechat_lift: p.wechat_lift,
    reply_lift: p.reply_lift,
    summary: p.summary,
    computed_at: new Date().toISOString(),
  }));

  const ins = await supabase.from("patterns").insert(rows);
  if (ins.error) {
    console.warn("patterns insert failed:", ins.error.message);
  }

  return patterns;
}

/** Read patterns for a scope, ordered by absolute deviation from baseline. */
export async function loadPatterns(repId: number | null): Promise<Pattern[]> {
  let q = supabase
    .from("patterns")
    .select("*")
    .order("computed_at", { ascending: false });
  if (repId === null) {
    q = q.is("scope_rep_id", null);
  } else {
    q = q.eq("scope_rep_id", repId);
  }
  const { data, error } = await q;
  if (error) return [];
  // Sort by interest: largest |lift - 1| first.
  return (data ?? [])
    .map((r) => r as Pattern)
    .sort((a, b) => Math.abs(b.wechat_lift - 1) - Math.abs(a.wechat_lift - 1));
}

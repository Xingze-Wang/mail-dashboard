import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { computeSegmentFunnels } from "@/lib/segment-funnels";
import { llmChat } from "@/lib/llm-proxy";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/insights-realign
 *
 * Daily cron (cron-as-gatekeeper). For each dimension cut, asks an
 * LLM: "given yesterday's published numbers vs. today's freshly-
 * computed numbers, has anything changed enough that we should
 * publish a new snapshot today?"
 *
 * Outcomes per (dimension, scope):
 *   - Realign: insert a new insights_snapshots row for today;
 *     payload from today's compute, prev_snapshot_id pointing at
 *     yesterday, realignment_reason set to a one-sentence LLM
 *     rationale that becomes the page banner.
 *   - Stay: do nothing. The page keeps reading yesterday's row.
 *     (We do NOT insert a "stay" row — the unique index would just
 *     re-find yesterday's snapshot tomorrow, which is what we want.)
 *
 * The page never recomputes on click. Stable mental model: users
 * see the same numbers all day, can reference them in conversation,
 * and only re-read when the banner says "realigned".
 *
 * Auth: Bearer $CRON_SECRET (matches the rest of /api/cron/*).
 *
 * Triggered by Vercel cron. See vercel.json for the schedule
 * (recommended `0 6 * * *` — daily 06:00 UTC, after the morning
 * arxiv scan settles).
 */

const REALIGN_DIMS = [
  "geo_binary",
  "geo_detail",                            // 20-bucket region breakdown (mig… well, just app code)
  "school_tier",
  "lead_tier",
  "h_index",
  "citations",
  "direction",
] as const;
type Dim = typeof REALIGN_DIMS[number];

const SYSTEM = `你是 insights gatekeeper. 收到两个版本的同一个 dimension cut:
- yesterday: 上一次发布给用户的数据
- today: 今天最新计算的数据

你判断是否需要发布今天的版本 (realign):
- 如果有 segment 的 ctr 变化 ≥3pp 或者 post-click conv 变化 ≥5pp, 算 meaningful
- 如果某个 segment 的样本量翻了一倍 (n_2x ≥ 2), 算 meaningful
- 如果有 segment 出现/消失, 算 meaningful
- 如果只是 ±1pp 噪声, 不要 realign — 让用户保持稳定的认知

输出严格 JSON: { "realign": boolean, "reason": string (≤1 sentence, 中文, 引用具体数字), "biggest_movement": { "segment": string, "metric": "ctr"|"post_click_conv"|"sample_size", "from": number, "to": number } | null }`;

interface CutPayload {
  segments: Array<{
    segment: string;
    delivered: number;
    clicked: number;
    wechat: number;
    ctr: number;
    postClickConv: number;
    endToEnd: number;
    lowN: boolean;
  }>;
  totals: { delivered: number; clicked: number; wechat: number };
}

interface DecisionResult {
  realign: boolean;
  reason: string;
  biggest_movement: {
    segment: string;
    metric: "ctr" | "post_click_conv" | "sample_size";
    from: number;
    to: number;
  } | null;
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const results: Array<{ dim: Dim; outcome: "realigned" | "stayed" | "bootstrap" | "error"; reason?: string }> = [];

  // One shared funnel compute per scope so we don't re-do work for
  // every dimension. The dimensions are different cuts of the same
  // underlying recipient list.
  const funnels = await computeSegmentFunnels({ repId: null, lookbackDays: 90 });

  for (const dim of REALIGN_DIMS) {
    try {
      const dimension = funnels.dimensions.find((d) => d.dimension === dim);
      if (!dimension) {
        results.push({ dim, outcome: "error", reason: "dimension not in funnel output" });
        continue;
      }
      const todayPayload: CutPayload = {
        segments: dimension.segments,
        totals: funnels.totals,
      };

      // Find the most recent published snapshot for this (dim, org-wide, 90d).
      const { data: prev } = await supabase
        .from("insights_snapshots")
        .select("id, payload, effective_date")
        .eq("dimension", dim)
        .is("rep_id", null)
        .eq("lookback_days", 90)
        .order("effective_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      // No prior snapshot → bootstrap (publish today's, no realignment_reason).
      if (!prev) {
        await supabase.from("insights_snapshots").insert({
          dimension: dim,
          rep_id: null,
          lookback_days: 90,
          payload: todayPayload,
          decided_by: "bootstrap",
          effective_date: today,
        });
        results.push({ dim, outcome: "bootstrap" });
        continue;
      }

      // Already published today (e.g. cron re-run within the same day) → no-op.
      if (prev.effective_date === today) {
        results.push({ dim, outcome: "stayed", reason: "already published today" });
        continue;
      }

      // Ask the LLM whether today's data is different enough to realign.
      const decision = await decideRealign(prev.payload as CutPayload, todayPayload);
      if (!decision || !decision.realign) {
        results.push({ dim, outcome: "stayed", reason: decision?.reason ?? "no decision" });
        continue;
      }

      // Realign: insert today's snapshot pointing back to the previous one.
      await supabase.from("insights_snapshots").insert({
        dimension: dim,
        rep_id: null,
        lookback_days: 90,
        payload: todayPayload,
        prev_snapshot_id: prev.id as string,
        realignment_reason: decision.reason,
        movement_summary: decision.biggest_movement,
        decided_by: "cron",
        effective_date: today,
        decision_model: "gemini-3-flash",
      });
      results.push({ dim, outcome: "realigned", reason: decision.reason });
    } catch (e) {
      results.push({ dim, outcome: "error", reason: (e as Error).message.slice(0, 200) });
    }
  }

  return NextResponse.json({ ok: true, today, results });
}

async function decideRealign(prev: CutPayload, today: CutPayload): Promise<DecisionResult | null> {
  // Trim to the top-N largest segments so the prompt stays small.
  // Top by delivered count keeps the decision focused on cohorts that
  // actually have signal.
  const topPrev = [...prev.segments].sort((a, b) => b.delivered - a.delivered).slice(0, 10);
  const topToday = [...today.segments].sort((a, b) => b.delivered - a.delivered).slice(0, 10);

  const user = JSON.stringify({
    yesterday: {
      totals: prev.totals,
      segments: topPrev.map((s) => ({
        segment: s.segment,
        delivered: s.delivered,
        clicked: s.clicked,
        wechat: s.wechat,
        ctr: Number((s.ctr * 100).toFixed(1)),
        post_click_conv: Number((s.postClickConv * 100).toFixed(1)),
      })),
    },
    today: {
      totals: today.totals,
      segments: topToday.map((s) => ({
        segment: s.segment,
        delivered: s.delivered,
        clicked: s.clicked,
        wechat: s.wechat,
        ctr: Number((s.ctr * 100).toFixed(1)),
        post_click_conv: Number((s.postClickConv * 100).toFixed(1)),
      })),
    },
  });

  try {
    const r = await llmChat({
      model: "gemini-3-flash",
      system: SYSTEM,
      user,
      json: true,
      max_tokens: 500,
      temperature: 0.3,
      timeoutMs: 30_000,
    });
    return JSON.parse(r.text) as DecisionResult;
  } catch (err) {
    console.error("[insights-realign] LLM decide failed:", err);
    return null;
  }
}

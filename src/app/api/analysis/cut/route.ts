// GET /api/analysis/cut?dim={geo_binary|geo_detail|school_tier|lead_tier|h_index|citations|direction}
//
// Reads from insights_snapshots (mig 075). Daily LLM cron decides
// whether to publish a new snapshot — see /api/cron/insights-realign.
// Users see the same numbers all day; the realignment banner fires
// only when the day's data has actually moved meaningfully.
//
// Bootstrapping fallback: if no snapshot exists yet (very first read
// after migration), fall through to a live compute and inline-publish
// the result with decided_by='bootstrap'.
//
// LLM summary is cached on the snapshot too (computed once during
// realignment, not on every page click).

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { computeSegmentFunnels } from "@/lib/segment-funnels";
import { llmChat } from "@/lib/llm-proxy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "claude-sonnet-4.6";

const KNOWN_DIMS: Record<string, { label: string; sliceLabel: string }> = {
  geo_binary:   { label: "Domestic .cn vs Overseas",     sliceLabel: "geography" },
  geo_detail:   { label: "By country / domain",          sliceLabel: "geography" },
  school_tier:  { label: "By school tier",               sliceLabel: "school tier" },
  lead_tier:    { label: "By lead tier (strong/normal)", sliceLabel: "lead tier" },
  h_index:      { label: "By author H-index",            sliceLabel: "H-index" },
  citations:    { label: "By citation count",            sliceLabel: "citation count" },
  direction:    { label: "By research direction",        sliceLabel: "research direction" },
  geo_x_school: { label: "Geography × school tier",      sliceLabel: "geo × school" },
};

const SYSTEM = (sliceLabel: string) => `你是 org 的 Chief of Staff. 看了下面按 ${sliceLabel} 切的 click + post-click conversion 数据, 写一段 3-5 句的判断给团队看.

要求:
- 第一句给一个**带立场的总结**
- 接着 2-3 句把最有说服力的对比指出来, 带数字
- 最后一句给一个**具体动作**
- 不要废话

输出严格 JSON: { "summary": string, "biggest_lever": string (≤8 词), "should_pitch_to_congress": boolean }`;

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const dim = url.searchParams.get("dim") ?? "geo_binary";
  if (!KNOWN_DIMS[dim]) {
    return NextResponse.json({ error: `unknown dim: ${dim}. Known: ${Object.keys(KNOWN_DIMS).join(", ")}` }, { status: 400 });
  }
  const meta = KNOWN_DIMS[dim];

  const isAdmin = session.role === "admin";
  const repIdParam = url.searchParams.get("repId");
  const daysParam = url.searchParams.get("days");

  let repId: number | null = null;
  if (isAdmin && repIdParam && repIdParam !== "all") {
    const n = Number(repIdParam);
    if (Number.isFinite(n)) repId = n;
  } else if (!isAdmin) {
    repId = session.repId;
  }
  const lookbackDays = daysParam ? Math.max(7, Math.min(365, Number(daysParam) || 90)) : 90;

  // Fast path: read most-recent published snapshot for this scope.
  // Per-rep snapshots are stored separately when present; we check
  // those first, then fall back to org-wide if a per-rep one doesn't
  // exist (most common — the daily cron only computes org-wide).
  const snapshot = await readSnapshot({ dim, repId, lookbackDays });
  if (snapshot) {
    return NextResponse.json({
      dim,
      label: meta.label,
      slice_label: meta.sliceLabel,
      scope: { repId, lookbackDays, isAdmin },
      totals: snapshot.payload.totals,
      segments: snapshot.payload.segments ?? [],
      summary: snapshot.payload.summary ?? null,
      // Realignment banner data — when present the page shows
      // "Previous: A%. This week: B%. ..."
      realignment: snapshot.realignment_reason
        ? {
            reason: snapshot.realignment_reason,
            movement: snapshot.movement_summary,
            effective_date: snapshot.effective_date,
            prev_snapshot_id: snapshot.prev_snapshot_id,
          }
        : null,
      effective_date: snapshot.effective_date,
      generated_at: snapshot.computed_at,
      source: "snapshot",
    });
  }

  // Bootstrap fallback: no snapshot yet (e.g. day 1 after deploy
  // before the cron has fired, or a per-rep view that's never been
  // computed). Compute live, persist as a bootstrap row so the
  // next click is fast.
  const funnels = await computeSegmentFunnels({ repId, lookbackDays });
  const dimension = funnels.dimensions.find((d) => d.dimension === dim);

  let summary: { summary: string; biggest_lever: string; should_pitch_to_congress: boolean } | null = null;
  if (dimension && dimension.segments.length > 0) {
    try {
      const out = await llmChat({
        model: MODEL,
        system: SYSTEM(meta.sliceLabel),
        user: JSON.stringify({
          scope: isAdmin ? "admin" : "rep",
          rep_name: session.repName ?? null,
          dim,
          lookback_days: lookbackDays,
          totals: funnels.totals,
          segments: dimension.segments,
        }),
        json: true,
        max_tokens: 700,
        temperature: 0.3,
        timeoutMs: 35_000,
      });
      summary = JSON.parse(out.text);
    } catch (err) {
      console.error("[cut] LLM summary failed", err);
    }
  }

  // Persist bootstrap. Idempotent via the (dim, scope, date) unique
  // index — if two requests race, second one no-ops on conflict.
  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    totals: funnels.totals,
    segments: dimension?.segments ?? [],
    summary,
  };
  await supabase.from("insights_snapshots").upsert(
    {
      dimension: dim,
      rep_id: repId,
      lookback_days: lookbackDays,
      payload,
      decided_by: "bootstrap",
      effective_date: today,
    },
    { onConflict: "dimension,rep_id,lookback_days,effective_date" },
  );

  return NextResponse.json({
    dim,
    label: meta.label,
    slice_label: meta.sliceLabel,
    scope: { repId, lookbackDays, isAdmin },
    totals: funnels.totals,
    segments: dimension?.segments ?? [],
    summary,
    realignment: null,
    effective_date: today,
    generated_at: new Date().toISOString(),
    source: "bootstrap",
  });
}

interface SnapshotRow {
  payload: { totals: { delivered: number; clicked: number; wechat: number }; segments: unknown[]; summary: unknown };
  realignment_reason: string | null;
  movement_summary: unknown;
  prev_snapshot_id: string | null;
  effective_date: string;
  computed_at: string;
}

/**
 * Read the most-recent published snapshot for (dim, scope). For per-rep
 * scope we first try the rep-specific snapshot; if none, we use the
 * org-wide one (because the cron only realigns org-wide).
 */
async function readSnapshot(args: { dim: string; repId: number | null; lookbackDays: number }): Promise<SnapshotRow | null> {
  const { dim, repId, lookbackDays } = args;
  const probe = async (rid: number | null): Promise<SnapshotRow | null> => {
    let q = supabase
      .from("insights_snapshots")
      .select("payload, realignment_reason, movement_summary, prev_snapshot_id, effective_date, computed_at")
      .eq("dimension", dim)
      .eq("lookback_days", lookbackDays)
      .order("effective_date", { ascending: false })
      .limit(1);
    q = rid == null ? q.is("rep_id", null) : q.eq("rep_id", rid);
    const { data, error } = await q.maybeSingle();
    if (error || !data) return null;
    return data as SnapshotRow;
  };
  if (repId != null) {
    const perRep = await probe(repId);
    if (perRep) return perRep;
  }
  return probe(null);
}

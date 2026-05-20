import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

/**
 * GET /api/cron/redraft-quarantined
 *
 * Bounded retry loop for leads stuck in qc_quarantined / judge_quarantined.
 * Every 6h, flip up to BATCH rows back to 'queued' so the regular
 * draft-queue picks them up and re-runs the full QC stack against them.
 *
 * Why bounded: a lead that fails QC 3 times in a row is unlikely to
 * suddenly pass on attempt 4. After MAX_CYCLES we leave it alone — admin
 * decides whether to override or drop it.
 *
 * The cycle count is tracked via the existing `qc_retry_count` column
 * (migration 103) which draft-queue already maintains.
 *
 * Auth: Bearer $CRON_SECRET (Vercel cron) or x-vercel-cron header.
 */

const BATCH = 40;
const MAX_CYCLES = 3;

function checkAuth(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron") === "1") return true;
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Pick the oldest quarantined leads first — they've been waiting longest.
  // `qc_retry_count` from mig 103 doubles as our "how many rewrite cycles
  // has this lead been through" counter. Hard-cap at MAX_CYCLES.
  const { data: rows, error } = await supabase
    .from("pipeline_leads")
    .select("id, status, qc_retry_count, assigned_rep_id")
    .in("status", ["qc_quarantined", "judge_quarantined"])
    .or(`qc_retry_count.is.null,qc_retry_count.lt.${MAX_CYCLES}`)
    .order("created_at", { ascending: true })
    .limit(BATCH);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({ flipped: 0, message: "no eligible quarantined leads" });
  }

  // Bump qc_retry_count and flip back to queued. The next draft-queue
  // pass picks them up and re-runs the full gate (salvage + grounding +
  // 3-model judge + appropriateness). If they fail again, they cycle back
  // to quarantine with retry_count incremented.
  const ids = rows.map((r) => r.id);
  const updates = rows.map((r) => ({
    id: r.id,
    status: "queued" as const,
    qc_retry_count: (Number(r.qc_retry_count) || 0) + 1,
  }));

  // Supabase doesn't support bulk update-with-different-values cleanly;
  // do per-row updates. Small batch so latency is bounded.
  let flipped = 0;
  for (const u of updates) {
    const { error: upErr } = await supabase
      .from("pipeline_leads")
      .update({ status: u.status, qc_retry_count: u.qc_retry_count })
      .eq("id", u.id);
    if (!upErr) flipped++;
  }

  return NextResponse.json({
    flipped,
    total_eligible: rows.length,
    max_cycles: MAX_CYCLES,
    ids: ids.slice(0, 10),  // sample for audit
  });
}

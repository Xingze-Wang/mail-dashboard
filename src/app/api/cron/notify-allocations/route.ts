// One-shot route: for every allocation_log row with notification_status=null
// on the requested due_date (default today), send the per-rep Lark DM via
// allocation-notifier. Idempotent — the notifier itself updates the status,
// so re-running won't re-notify.
//
// Auth: Bearer $CRON_SECRET. Same auth as the rest of /api/cron/*.
//
// This exists because the master allocator route does notifications in-line,
// but if someone allocates by other means (a script, or the previous run's
// notifications failed) you need a clean way to flush the queue. Hand-rolled
// re-trigger.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dueDate = url.searchParams.get("due_date") ?? new Date().toISOString().slice(0, 10);

  // Pull every unnotified row for the day. Each row carries one
  // (rep_id, pool_key, lead_ids[]) so we aggregate per-rep below.
  const { data: rows, error } = await supabase
    .from("allocation_log")
    .select("rep_id, pool_key, lead_ids, notification_status")
    .eq("due_date", dueDate)
    .is("notification_status", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, due_date: dueDate, unnotified: 0 });
  }

  // Aggregate per-rep so each rep gets ONE DM, not one per pool.
  type Agg = { per_pool_actual: Record<string, number>; total_allocated: number };
  const perRep = new Map<number, Agg>();
  for (const r of rows) {
    let agg = perRep.get(r.rep_id as number);
    if (!agg) {
      agg = { per_pool_actual: { strong: 0, normal_cn: 0, normal_overseas: 0, normal_edu: 0 }, total_allocated: 0 };
      perRep.set(r.rep_id as number, agg);
    }
    const count = Array.isArray(r.lead_ids) ? (r.lead_ids as unknown[]).length : 0;
    agg.per_pool_actual[r.pool_key as string] = (agg.per_pool_actual[r.pool_key as string] ?? 0) + count;
    agg.total_allocated += count;
  }

  const { notifyRepOfAllocation } = await import("@/lib/allocation-notifier");
  const results: Array<{ rep_id: number; total: number; status: string }> = [];
  for (const [repId, agg] of perRep) {
    const status = await notifyRepOfAllocation({
      rep_id: repId,
      due_date: dueDate,
      per_pool_actual: agg.per_pool_actual as never,
      underfilled: [],
      total_allocated: agg.total_allocated,
    });
    results.push({ rep_id: repId, total: agg.total_allocated, status });
  }

  return NextResponse.json({ ok: true, due_date: dueDate, results });
}

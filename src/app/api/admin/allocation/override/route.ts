import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { supabase } from "@/lib/db";
import { allocateForRep } from "@/lib/allocator";
import { normalizePerPool } from "@/lib/pool-types";

export const dynamic = "force-dynamic";

/**
 * POST body: { rep_id, per_pool, reason? }
 * Effect: revoke today's allocations for this rep (return leads to pool),
 * re-run allocator with new per_pool. Audit row tagged allocator='admin:N'.
 */
export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const repId = Number(body.rep_id);
  if (!Number.isFinite(repId) || repId <= 0) {
    return NextResponse.json({ error: "rep_id required" }, { status: 400 });
  }
  const perPool = normalizePerPool(body.per_pool);
  const reason = typeof body.reason === "string" ? body.reason : null;
  const today = new Date().toISOString().slice(0, 10);

  const mission = await supabase
    .from("missions")
    .select("id")
    .eq("rep_id", repId)
    .eq("due_date", today)
    .eq("kind", "send")
    .maybeSingle();
  if (!mission.data) {
    return NextResponse.json({ error: "no send mission today for this rep" }, { status: 404 });
  }

  const prior = await supabase
    .from("allocation_log")
    .select("lead_ids")
    .eq("rep_id", repId)
    .eq("due_date", today);
  const priorLeadIds = (prior.data || []).flatMap((r) => r.lead_ids as string[]);
  if (priorLeadIds.length > 0) {
    await supabase.from("pipeline_leads").update({ assigned_rep_id: null }).in("id", priorLeadIds);
    await supabase.from("allocation_log").delete().eq("rep_id", repId).eq("due_date", today);
  }

  const result = await allocateForRep({
    mission_id: mission.data.id as string,
    rep_id: repId,
    due_date: today,
    per_pool: perPool,
    direction_priority: [],
    allocator: `admin:${session.repId}`,
    reason,
    shadow: false,
  });

  return NextResponse.json({ ok: true, result });
}

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { supabase } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const today = new Date().toISOString().slice(0, 10);

  const counts: Record<string, number> = {};
  for (const pk of ["strong", "normal_cn", "normal_overseas", "normal_edu"] as const) {
    const r = await supabase
      .from("v_lead_pool")
      .select("id", { count: "exact", head: true })
      .eq("pool_key", pk);
    counts[pk] = r.count ?? 0;
  }

  const logs = await supabase
    .from("allocation_log")
    .select("rep_id, pool_key, lead_ids, allocator, notification_status, created_at")
    .eq("due_date", today)
    .order("created_at", { ascending: true });

  const missions = await supabase
    .from("missions")
    .select("id, rep_id, target, scope, status")
    .eq("due_date", today)
    .eq("kind", "send");

  const reps = await supabase
    .from("sales_reps")
    .select("id, name, lark_open_id")
    .eq("active", true)
    .order("id");

  return NextResponse.json({
    today,
    pool_inventory: counts,
    allocations: logs.data || [],
    missions: missions.data || [],
    reps: reps.data || [],
  });
}

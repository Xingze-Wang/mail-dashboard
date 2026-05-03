// GET /api/congress/index — feeds the /congress page.
// Aggregates pending tactical proposals, recent ones, active strategic
// directives, recent strategic decisions, and JITR health stats.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [pending, recent, directives, recentStrategic, jitrPending, jitrAccepted, reps] = await Promise.all([
    supabase.from("tactical_proposals")
      .select("id, title, proposed_at, ship_decision, shipped_at, evaluation_due_at, expected_lift, actual_lift, grade")
      .eq("ship_decision", "pending")
      .order("proposed_at", { ascending: false }),
    supabase.from("tactical_proposals")
      .select("id, title, proposed_at, ship_decision, shipped_at, evaluation_due_at, expected_lift, actual_lift, grade")
      .neq("ship_decision", "pending")
      .order("proposed_at", { ascending: false })
      .limit(10),
    supabase.from("strategic_directives")
      .select("id, body, effective_from, active")
      .eq("active", true)
      .order("effective_from", { ascending: false }),
    supabase.from("strategic_decisions")
      .select("id, title, outcome, decided_at")
      .order("decided_at", { ascending: false })
      .limit(5),
    supabase.from("jitr_offers").select("*", { count: "exact", head: true }).eq("decision", "pending"),
    supabase.from("jitr_offers").select("*", { count: "exact", head: true })
      .eq("decision", "accept")
      .gte("offered_at", new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()),
    supabase.from("sales_reps").select("name, lark_open_id").eq("active", true),
  ]);

  const unboundReps = (reps.data ?? [])
    .filter((r) => !r.lark_open_id && r.name !== "Xingze Wang")
    .map((r) => r.name);

  return NextResponse.json({
    pending: pending.data ?? [],
    recent: recent.data ?? [],
    directives: directives.data ?? [],
    recent_strategic: recentStrategic.data ?? [],
    jitr_offers_pending: jitrPending.count ?? 0,
    jitr_offers_accepted_30d: jitrAccepted.count ?? 0,
    unbound_reps: unboundReps,
  });
}

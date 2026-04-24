import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { verifySession, AUTH_COOKIE } from "@/lib/auth";

/**
 * GET /api/metrics/me
 *
 * Per-rep Overview metrics for sales. Counts from pipeline_leads filtered
 * by assigned_rep_id. Complements /api/metrics (global email funnel) —
 * sales see *their* pipeline slice; admin keeps seeing the global view.
 *
 * Historical note: emails sent before the assigned_rep_id column existed
 * do not belong to anyone in particular — we treat Leo (id=1) as the
 * historical owner, so his per-rep view will look sparse unless he runs
 * /api/metrics too. The overview page handles that branch client-side.
 */
export async function GET(req: NextRequest) {
  const session = await verifySession(req.cookies.get(AUTH_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const repId = session.repId;

  // Count each status directly. Two important derivations:
  //
  // - `sent` counts both status='sent' AND status='replied', because
  //   "sent" to the rep means "an email went out" — reply is a later
  //   phase of the same send, not a displacement. Previously reps saw
  //   their sent count drop when replies came in, which read as a bug.
  //
  // - `wechat` counts DISTINCT pipeline_leads.id from brief_lookups
  //   where added_wechat=true AND that lead is assigned to this rep.
  //   Previously this checked pipeline_leads.status='wechat_added',
  //   but nothing writes that status — it was always zero. WeChat
  //   conversions live in brief_lookups (the conversion event log).
  const [
    { count: assigned },
    { count: ready },
    { count: sentOnly },
    { count: replied },
  ] = await Promise.all([
    supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId),
    supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId).eq("status", "ready"),
    supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId).eq("status", "sent"),
    supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId).eq("status", "replied"),
  ]);
  const sent = (sentOnly ?? 0) + (replied ?? 0);

  // WeChat conversions — unique leads this rep has marked as added on
  // WeChat. Two-step fetch (avoid relying on a postgrest-registered
  // FK between brief_lookups and pipeline_leads, which migration 016
  // adds but may not be live in all environments):
  //   1. Get this rep's lead ids.
  //   2. Count DISTINCT brief_lookups.lead_id where added_wechat=true
  //      AND lead_id is in that set.
  // If the rep has zero leads the result is 0 without hitting the
  // second query.
  let wechat = 0;
  {
    const { data: myLeadIds } = await supabase
      .from("pipeline_leads")
      .select("id")
      .eq("assigned_rep_id", repId);
    const idSet = new Set((myLeadIds ?? []).map((r) => r.id as string));
    if (idSet.size > 0) {
      const { data: convRows } = await supabase
        .from("brief_lookups")
        .select("lead_id")
        .eq("added_wechat", true)
        .not("lead_id", "is", null)
        .in("lead_id", Array.from(idSet));
      if (Array.isArray(convRows)) {
        const distinct = new Set<string>();
        for (const r of convRows) {
          const id = r.lead_id as string | null;
          if (id) distinct.add(id);
        }
        wechat = distinct.size;
      }
    }
  }

  return NextResponse.json({
    repId,
    repName: session.repName,
    assigned: assigned ?? 0,
    ready: ready ?? 0,
    sent,
    replied: replied ?? 0,
    wechat,
    leadRate: sent > 0 ? ((wechat / sent) * 100).toFixed(1) : "0.0",
  });
}

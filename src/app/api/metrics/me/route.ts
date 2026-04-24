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
  // WeChat. Uses brief_lookups (the conversion event table) joined to
  // pipeline_leads to keep the count scoped to THIS rep's leads.
  // Counting brief_lookups rows directly would double-count on repeat
  // clicks; DISTINCT lead_id dedups.
  let wechat = 0;
  {
    const { data: convRows } = await supabase
      .from("brief_lookups")
      .select("lead_id, pipeline_leads!inner(assigned_rep_id)")
      .eq("added_wechat", true)
      .eq("pipeline_leads.assigned_rep_id", repId)
      .not("lead_id", "is", null);
    if (Array.isArray(convRows)) {
      wechat = new Set(convRows.map((r) => r.lead_id as string)).size;
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

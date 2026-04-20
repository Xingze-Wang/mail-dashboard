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

  const [{ count: assigned }, { count: sent }, { count: replied }, { count: wechat }] =
    await Promise.all([
      supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId),
      supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId).eq("status", "sent"),
      supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId).eq("status", "replied"),
      supabase.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", repId).eq("status", "wechat_added"),
    ]);

  const ready = (assigned ?? 0) - (sent ?? 0) - (replied ?? 0) - (wechat ?? 0);

  return NextResponse.json({
    repId,
    repName: session.repName,
    assigned: assigned ?? 0,
    ready: Math.max(0, ready),
    sent: sent ?? 0,
    replied: replied ?? 0,
    wechat: wechat ?? 0,
    leadRate: (sent ?? 0) > 0 ? (((wechat ?? 0) / (sent ?? 0)) * 100).toFixed(1) : "0.0",
  });
}

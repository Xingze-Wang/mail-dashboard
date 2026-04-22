import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

/**
 * GET /api/pipeline/ready-count
 *
 * Returns count of pipeline_leads with status = 'ready'. Scoped per rep
 * for non-admin sessions so the sidebar badge matches the Pipeline page
 * (otherwise sales sees "Pipeline 561" in the sidebar but only ~167 rows
 * on the page — mismatch looks like a broken feature).
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  const isPrivileged = session?.role === "admin" || session?.role === "senior";

  let q = supabase
    .from("pipeline_leads")
    .select("*", { count: "exact", head: true })
    .eq("status", "ready");
  if (!isPrivileged && session?.repId) {
    q = q.eq("assigned_rep_id", session.repId);
  }
  const { count, error } = await q;
  if (error) {
    return NextResponse.json({ count: 0, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ count: count ?? 0 });
}

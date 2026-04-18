import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";

/**
 * GET /api/pipeline/ready-count
 *
 * Returns count of pipeline_leads with status = 'ready'.
 * Used by the sidebar `Emails` badge to surface "drafts pending send".
 */
export async function GET() {
  const { count, error } = await supabase
    .from("pipeline_leads")
    .select("*", { count: "exact", head: true })
    .eq("status", "ready");

  if (error) {
    return NextResponse.json({ count: 0, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ count: count ?? 0 });
}

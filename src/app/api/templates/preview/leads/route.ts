import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/templates/preview/leads
 *
 * Returns 5 most recent sent leads with enough metadata to render a
 * preview against any template. Admin-only because the dropdown shows
 * leads across all reps.
 */
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data, error } = await supabase
    .from("pipeline_leads")
    .select("id, title, author_name, author_email, abstract, school_name, school_tier, matched_directions, assigned_rep_id")
    .eq("status", "sent")
    .not("title", "is", null)
    .not("abstract", "is", null)
    .order("sent_at", { ascending: false })
    .limit(5);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ leads: data ?? [] });
}

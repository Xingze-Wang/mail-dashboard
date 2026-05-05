// GET /api/mapping/drafts — list pending drafts the current rep should approve.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Admins see all pending drafts; everyone else sees drafts whose
  // target.owner_rep_id == them.
  const { data: drafts, error } = await supabase
    .from("mapping_drafts")
    .select("id, target_id, lead_id, subject, body_html, match_reason, created_at, target:mapping_targets(label, owner_rep_id)")
    .eq("state", "pending")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const filtered = (drafts ?? []).filter((d) => {
    if (session.role === "admin") return true;
    const t = d.target as unknown as { owner_rep_id?: number } | null;
    return t?.owner_rep_id === session.repId;
  });

  // Hydrate lead details for each draft.
  const leadIds = Array.from(new Set(filtered.map((d) => d.lead_id))).filter(Boolean) as string[];
  const leadById = new Map<string, { author_name: string | null; author_email: string; title: string | null }>();
  if (leadIds.length > 0) {
    const { data: leads } = await supabase
      .from("pipeline_leads")
      .select("id, author_name, author_email, title")
      .in("id", leadIds);
    for (const l of leads ?? []) leadById.set(l.id as string, {
      author_name: l.author_name as string | null,
      author_email: l.author_email as string,
      title: l.title as string | null,
    });
  }

  return NextResponse.json({
    drafts: filtered.map((d) => ({ ...d, lead: leadById.get(d.lead_id) ?? null })),
  });
}

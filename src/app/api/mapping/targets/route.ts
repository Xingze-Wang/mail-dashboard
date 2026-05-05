// GET /api/mapping/targets — list this rep's mapping targets.

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Admins see all targets; everyone else sees their own.
  let q = supabase
    .from("mapping_targets")
    .select("id, owner_rep_id, label, spec, candidate_active, active, created_at")
    .eq("active", true)
    .order("created_at", { ascending: false });
  if (session.role !== "admin") q = q.eq("owner_rep_id", session.repId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ targets: data ?? [] });
}

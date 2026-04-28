import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/help/predictions/recent
 *
 * Admin: org-wide recent predictions + accuracy summary.
 * Sales: own predictions only.
 *
 * Returns: { predictions: [...], accuracy: { resolved, correct, ratio } }.
 * The accuracy snapshot is for "is the helper getting better over
 * time?" — admin views this on the integrity tile.
 */
export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let q = supabase
    .from("helper_predictions")
    .select("*")
    .order("made_at", { ascending: false })
    .limit(50);
  if (session.role !== "admin") q = q.eq("rep_id", session.repId);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const resolved = rows.filter((r) => r.resolved_correct !== null);
  const correct = resolved.filter((r) => r.resolved_correct === true).length;
  const ratio = resolved.length > 0 ? Number((correct / resolved.length).toFixed(2)) : null;

  return NextResponse.json({
    predictions: rows,
    accuracy: { resolved: resolved.length, correct, ratio },
  });
}

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { refreshPatterns } from "@/lib/patterns";
import { supabase } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/patterns/refresh
 *
 * Recomputes the org-wide patterns + per-rep patterns. Admin-only —
 * this is an admin-triggered refresh; the cron job will hit the same
 * endpoint daily once wired.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  // Org-wide first.
  const org = await refreshPatterns(null, "org-wide");

  // Per-rep for every active rep.
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, name")
    .eq("active", true);

  const perRepCounts: Array<{ repId: number; name: string; patterns: number }> = [];
  for (const rep of reps ?? []) {
    const out = await refreshPatterns(rep.id as number, rep.name as string);
    perRepCounts.push({ repId: rep.id as number, name: rep.name as string, patterns: out.length });
  }

  return NextResponse.json({
    ok: true,
    orgWidePatterns: org.length,
    perRep: perRepCounts,
  });
}

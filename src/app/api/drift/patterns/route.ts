import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/drift/patterns?status=pending&repId=2&category=format
 *
 * Lists mined drift patterns with optional filters. Admin-only.
 * Default returns last 200 patterns ordered by detected_at desc.
 */
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const url = new URL(req.url);
  const status = url.searchParams.get("status"); // pending | accepted | ignored | null=all
  const repIdRaw = url.searchParams.get("repId"); // numeric | "global" | null=all
  const category = url.searchParams.get("category");

  let q = supabase
    .from("prompt_drift_patterns")
    .select("*")
    .order("detected_at", { ascending: false })
    .limit(200);

  if (status) q = q.eq("status", status);
  if (category) q = q.eq("category", category);
  if (repIdRaw === "global") q = q.is("rep_id", null);
  else if (repIdRaw && /^\d+$/.test(repIdRaw)) q = q.eq("rep_id", Number(repIdRaw));

  const { data, error } = await q;
  if (error) {
    // Typical cause: migration 008 not applied → prompt_drift_patterns
    // table doesn't exist. Surface this precisely so admin knows the
    // fix, instead of a blank page or raw SQL error.
    const msg = error.message || "";
    const missingTable = /relation .* does not exist/i.test(msg) || /no such table/i.test(msg);
    if (missingTable) {
      return NextResponse.json({
        patterns: [],
        counts: { pending: 0, accepted: 0, ignored: 0, total: 0 },
        byCategory: {},
        setupHint: "Drift tables missing — run migrations/008-drift-and-edit-tracking.sql in Supabase SQL Editor.",
      });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Aggregate counts for the dashboard header
  const { data: allRows } = await supabase
    .from("prompt_drift_patterns")
    .select("status, category");
  const counts = { pending: 0, accepted: 0, ignored: 0, total: 0 };
  const byCategory: Record<string, number> = {};
  for (const r of allRows ?? []) {
    counts.total++;
    if (r.status === "pending") counts.pending++;
    else if (r.status === "accepted") counts.accepted++;
    else if (r.status === "ignored") counts.ignored++;
    const c = (r.category as string) || "unknown";
    byCategory[c] = (byCategory[c] ?? 0) + 1;
  }

  // Attach rep_name so the UI can render "· Leo" instead of "· rep #3".
  // Load all reps (including inactive) — historical patterns may belong to
  // someone who's since been deactivated.
  const { data: repsRaw } = await supabase.from("sales_reps").select("id, name, sender_name");
  const repNameById = new Map<number, string>();
  for (const r of repsRaw ?? []) {
    const id = r.id as number;
    const display = (r.sender_name as string | null) || (r.name as string | null) || "Unknown rep";
    repNameById.set(id, display);
  }
  const patterns = (data ?? []).map((p) => ({
    ...p,
    rep_name: p.rep_id == null ? null : (repNameById.get(p.rep_id as number) ?? "Unknown rep"),
  }));

  return NextResponse.json({ patterns, counts, byCategory });
}

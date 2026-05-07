import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { getCapabilities } from "@/lib/trust-level";

/**
 * GET /api/admin/rep-trust?rep_id=N
 * POST /api/admin/rep-trust { rep_id: number, trust_level?: int, trust_notes?: string }
 *
 * Admin-only. Lets admins inspect and override a rep's training-wheels tier.
 * Negative trust_level locks the rep into the 'restricted' tier; positive
 * values bump them up tiers without waiting for sends to accumulate.
 *
 * Why we need this even though the tier is auto-derived from totalSends:
 *   - Onboarding day-zero override ("Yujie's coming back from another team,
 *     skip her past the training tier")
 *   - Performance-based throttle ("Dani had 3 bad sends, lock her down
 *     until I review")
 *   - Admin trust beyond what tenure shows
 */

async function requireAdmin(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return null;
  // Re-read role from DB — JWT could be stale per CLAUDE.md auth model
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") return null;
  return session;
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const url = new URL(req.url);
  const repIdRaw = url.searchParams.get("rep_id");
  if (!repIdRaw) {
    // No rep_id → return all reps' capabilities. Useful for admin UI grid.
    const { data: reps } = await supabase
      .from("sales_reps")
      .select("id")
      .eq("active", true)
      .order("id");
    const out = await Promise.all((reps ?? []).map((r) => getCapabilities(r.id)));
    return NextResponse.json({ reps: out });
  }
  const repId = Number(repIdRaw);
  if (!Number.isFinite(repId)) {
    return NextResponse.json({ error: "rep_id must be numeric" }, { status: 400 });
  }
  const caps = await getCapabilities(repId);
  return NextResponse.json(caps);
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  let body: { rep_id?: number; trust_level?: number; trust_notes?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const repId = body.rep_id;
  if (typeof repId !== "number") {
    return NextResponse.json({ error: "rep_id required" }, { status: 400 });
  }
  // Build a sparse update — only set fields the client explicitly passed.
  const updates: Record<string, unknown> = {};
  if (typeof body.trust_level === "number") {
    // Tightened from [-1, 5] after audit: classifyTier only reads
    // trust_level as { -1, 0, 1, >=2 } so values 3+ silently collapsed
    // to the same tier as 2. Reject anything outside the meaningful
    // range so admins don't think trust_level=5 is an "admin-tier" pin.
    if (!Number.isInteger(body.trust_level) || body.trust_level < -1 || body.trust_level > 2) {
      return NextResponse.json(
        { error: "trust_level must be one of [-1, 0, 1, 2] (use role=senior/admin for true admin tier)" },
        { status: 400 },
      );
    }
    updates.trust_level = body.trust_level;
  }
  // Self-edit guard — admins should not be able to bump their own
  // trust_level via this route. They already have admin-tier from role;
  // the trust_level column on an admin row is a no-op (classifyTier
  // returns 'admin' regardless). Blocking self-edits removes a
  // confused-deputy footgun if an admin account is later compromised
  // and demoted: the attacker can't pre-pin themselves to mature.
  if (repId === admin.repId) {
    return NextResponse.json(
      { error: "Cannot edit your own trust_level via this route" },
      { status: 400 },
    );
  }
  if (typeof body.trust_notes === "string") {
    updates.trust_notes = body.trust_notes.slice(0, 500); // cap to keep DB sane
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "Provide at least one of trust_level or trust_notes" },
      { status: 400 },
    );
  }
  const { error } = await supabase
    .from("sales_reps")
    .update(updates)
    .eq("id", repId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const caps = await getCapabilities(repId);
  return NextResponse.json({ ok: true, capabilities: caps });
}

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { supabase } from "@/lib/db";
import { getMpConversionMatrix } from "@/lib/canonical-counts";

/**
 * GET /api/admin/mp-conversion-matrix?since_days=90
 *
 * Admin-only read of the MiraclePlus conversion matrix
 * (registered / submitted / wechat-added, plus per-rep rollup).
 *
 * Auth: JWT + DB role re-check (per CLAUDE.md — never trust the JWT's
 * role field; a demoted admin loses access immediately).
 *
 * Returns: the canonical `MpConversionMatrix` shape from
 * `canonical-counts.ts` PLUS a `rep_names` map { rep_id: name } so the
 * client can render per-rep names without a second round-trip.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  const url = new URL(req.url);
  const sinceDaysRaw = Number(url.searchParams.get("since_days"));
  const sinceDays =
    Number.isFinite(sinceDaysRaw) && sinceDaysRaw > 0
      ? Math.min(365, Math.max(1, Math.floor(sinceDaysRaw)))
      : 90;
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

  try {
    const matrix = await getMpConversionMatrix({ since });
    // Pull rep names for the perRep array. Cheap (≤10 reps).
    const repIds = (matrix.perRep ?? []).map((r) => r.rep_id);
    let repNames: Record<number, string> = {};
    if (repIds.length > 0) {
      const { data: reps } = await supabase
        .from("sales_reps")
        .select("id, name")
        .in("id", repIds);
      for (const r of reps ?? []) {
        repNames[r.id as number] = (r.name as string) ?? `rep#${r.id}`;
      }
    }
    return NextResponse.json({
      ok: true,
      window_days: sinceDays,
      matrix,
      rep_names: repNames,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

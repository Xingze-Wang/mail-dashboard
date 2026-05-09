import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

/**
 * GET /api/templates/[id]/judge
 *   Returns this admin's existing rating (if any) + the AI rating
 *   for side-by-side reference. Used to pre-fill the judge UI so a
 *   re-rate is an edit, not a from-scratch.
 *
 * POST /api/templates/[id]/judge
 *   Body: { politeness, clarity, peer_register, brand_fit,
 *           factual_accuracy, naturalness, reasoning? }  (all 1-10 ints)
 *   Upserts a row in template_ratings (rater_kind='human', rater_id=
 *   session.repId). One row per (template, admin) — re-rating from
 *   the same admin overwrites their previous row.
 *
 * Auth: admin only. Per-admin rows means we can compare admins to
 * each other later (calibration across humans, not just human-vs-AI).
 */

async function requireAdmin(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return null;
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role")
    .eq("id", session.repId)
    .maybeSingle();
  if (!rep || rep.role !== "admin") return null;
  return session;
}

const DIMS = ["politeness", "clarity", "peer_register", "brand_fit", "factual_accuracy", "naturalness"] as const;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const { id } = await params;

  const { data } = await supabase
    .from("template_ratings")
    .select("rater_kind, rater_id, politeness, clarity, peer_register, brand_fit, factual_accuracy, naturalness, reasoning, updated_at")
    .eq("template_id", id);

  const rows = data ?? [];
  const aiRating = rows.find((r) => r.rater_kind === "ai") ?? null;
  const myRating = rows.find((r) => r.rater_kind === "human" && r.rater_id === admin.repId) ?? null;
  const allHumanRatings = rows.filter((r) => r.rater_kind === "human");

  return NextResponse.json({
    ai_rating: aiRating,
    my_rating: myRating,
    all_human_ratings: allHumanRatings,
    n_humans: allHumanRatings.length,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const scores: Record<string, number> = {};
  for (const dim of DIMS) {
    const v = body[dim];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 10) {
      return NextResponse.json(
        { error: `${dim} must be int 1-10, got ${JSON.stringify(v)}` },
        { status: 400 },
      );
    }
    scores[dim] = Math.round(v);
  }

  const reasoning = typeof body.reasoning === "string" ? body.reasoning.slice(0, 1500) : null;

  const { error } = await supabase.from("template_ratings").upsert(
    {
      template_id: id,
      rater_kind: "human",
      rater_id: admin.repId,
      ...scores,
      reasoning,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "template_id,rater_kind,rater_id" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

/**
 * POST /api/emails/[id]/rate
 * Body: { score: 1-5, reasoning?: string }
 *
 * Human rep rates an email they sent (or are reviewing). Stored as
 * rater_kind='human' in email_ratings. Idempotent — same rep
 * re-rating updates the existing row. The reasoning field is
 * optional but encouraged: even a short note ("felt too generic")
 * later helps the predictor learn.
 *
 * Auth: any logged-in rep can rate. Pre-condition: rep must own the
 * email (rep_id or actor_rep_id matches their session.repId), OR be
 * admin. Otherwise 403.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    score?: unknown;
    reasoning?: unknown;
  };
  const score = typeof body.score === "number" ? Math.round(body.score) : NaN;
  const reasoning =
    typeof body.reasoning === "string" ? body.reasoning.slice(0, 1000) : null;
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    return NextResponse.json(
      { error: "score must be an integer 1-5" },
      { status: 400 },
    );
  }

  // Ownership check — non-admin can only rate their own emails.
  const { data: email } = await supabase
    .from("emails")
    .select("id, rep_id, actor_rep_id")
    .eq("id", id)
    .maybeSingle();
  if (!email) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const isAdmin = session.role === "admin";
  const isOwner =
    email.rep_id === session.repId || email.actor_rep_id === session.repId;
  if (!isAdmin && !isOwner) {
    return NextResponse.json({ error: "Not your email" }, { status: 403 });
  }

  const { error } = await supabase.from("email_ratings").upsert(
    {
      email_id: id,
      rater_kind: "human",
      rater_id: session.repId,
      score,
      reasoning,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "email_id,rater_kind" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

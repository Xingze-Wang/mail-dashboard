import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const maxDuration = 300;

/**
 * POST /api/admin/rate-recent
 * Body: { limit?: number, days?: number }
 *
 * Backfill admin tool: pick the N most-recent emails sent in the last
 * `days` window that have intro_output (i.e. were rendered through the
 * template assembler) AND don't yet have an AI rating, then call the
 * per-email AI rater for each. Stops at the limit.
 *
 * This is how the user kicks off "rate the last 30 emails so I can see
 * the agreement-gap data" without waiting for a cron. Sequential, not
 * parallel — each AI rating is a Gemini call (~5s) and we don't want
 * to blow Gemini's per-minute rate limit.
 *
 * Auth: admin only.
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

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { limit?: number; days?: number };
  const limit = Math.max(1, Math.min(50, body.limit ?? 20));
  const days = Math.max(1, Math.min(180, body.days ?? 30));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // Find emails with intro_output AND no existing AI rating.
  // Two-step: pull candidates first, then filter out ones already rated.
  const { data: candidates } = await supabase
    .from("emails")
    .select("id")
    .gte("created_at", since)
    .not("intro_output", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit * 3); // overfetch since some will already be rated

  const candidateIds = (candidates ?? []).map((e) => e.id as string);
  if (candidateIds.length === 0) {
    return NextResponse.json({ rated: 0, errors: 0, note: "No eligible emails" });
  }

  const { data: alreadyRated } = await supabase
    .from("email_ratings")
    .select("email_id")
    .eq("rater_kind", "ai")
    .in("email_id", candidateIds);
  const ratedSet = new Set((alreadyRated ?? []).map((r) => r.email_id as string));

  const toRate = candidateIds.filter((id) => !ratedSet.has(id)).slice(0, limit);

  // Build internal-fetch URL — calling our own /api/emails/[id]/ai-rate
  // for each. We piggyback on the user's session cookie so the inner
  // requireAdmin check passes.
  const cookie = req.headers.get("cookie") ?? "";
  const origin = new URL(req.url).origin;

  let rated = 0;
  let errors = 0;
  const results: Array<{ id: string; ok: boolean; error?: string; score?: number }> = [];

  for (const id of toRate) {
    try {
      const r = await fetch(`${origin}/api/emails/${id}/ai-rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
      });
      const j = (await r.json().catch(() => ({}))) as { score?: number; error?: string };
      if (r.ok) {
        rated++;
        results.push({ id, ok: true, score: j.score });
      } else {
        errors++;
        results.push({ id, ok: false, error: j.error ?? `HTTP ${r.status}` });
      }
    } catch (e) {
      errors++;
      results.push({ id, ok: false, error: (e as Error).message });
    }
  }

  return NextResponse.json({ rated, errors, total_candidates: toRate.length, results });
}

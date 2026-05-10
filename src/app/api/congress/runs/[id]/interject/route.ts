import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

/**
 * POST /api/congress/runs/[id]/interject
 *
 * Body: {
 *   body: string,                      // the comment (max 2000 chars)
 *   inject_after_idx?: number,         // optional override; default = current_idx
 * }
 *
 * Inserts a congress_interjections row. The next persona that runs
 * (current_idx + 1) will see this comment in its prompt context as
 * "中途插话: <author> — <body>".
 *
 * If the run is already 'completed' or 'failed', interjection is
 * still allowed (gets stored, just won't influence anything; could
 * be useful for post-hoc annotation history).
 *
 * Auth: any logged-in rep.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    body?: unknown;
    inject_after_idx?: unknown;
  };
  if (typeof body.body !== "string" || body.body.trim().length === 0) {
    return NextResponse.json({ error: "body required" }, { status: 400 });
  }
  const text = body.body.trim().slice(0, 2000);

  // Resolve current_idx so the default inject_after_idx targets
  // "the next persona to run".
  const { data: run } = await supabase
    .from("congress_runs")
    .select("current_idx, status")
    .eq("id", id)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const currentIdx = run.current_idx as number | null;
  const injectAfterIdx = typeof body.inject_after_idx === "number"
    ? body.inject_after_idx
    : (currentIdx ?? 0);

  const { data: row, error } = await supabase
    .from("congress_interjections")
    .insert({
      run_id: id,
      body: text,
      author_rep_id: session.repId,
      inject_after_idx: injectAfterIdx,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, interjection: row });
}

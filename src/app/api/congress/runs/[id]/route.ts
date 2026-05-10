import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/congress/runs/[id]
 *
 * Returns the live state of a stepwise congress run, including the
 * roster, which personas are done, what they said, and any pending
 * interjections. Polled by the /congress/[id]/live page every 2s.
 *
 * Returns interjections sorted oldest-first so the UI can display
 * the timeline. consumed_at distinguishes "queued for next persona"
 * from "already shown to a previous persona".
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const { id } = await params;
  const { data: run, error } = await supabase
    .from("congress_runs")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const { data: rawInterjections } = await supabase
    .from("congress_interjections")
    .select("id, body, author_rep_id, inject_after_idx, consumed_at, consumed_by_persona, created_at")
    .eq("run_id", id)
    .order("created_at", { ascending: true });

  const interjections = rawInterjections ?? [];
  const repIds = [...new Set(interjections.map((i) => i.author_rep_id as number))];
  const repName = new Map<number, string>();
  if (repIds.length > 0) {
    const { data: reps } = await supabase
      .from("sales_reps")
      .select("id, sender_name, name")
      .in("id", repIds);
    for (const r of reps ?? []) {
      repName.set(r.id as number, ((r.sender_name as string | null) ?? (r.name as string | null) ?? `rep#${r.id}`));
    }
  }

  return NextResponse.json({
    run,
    interjections: interjections.map((i) => ({
      ...i,
      author_name: repName.get(i.author_rep_id as number) ?? `rep#${i.author_rep_id}`,
    })),
  });
}

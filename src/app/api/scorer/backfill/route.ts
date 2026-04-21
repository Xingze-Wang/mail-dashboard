import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { scoreWithGemini } from "@/lib/gemini-scorer";
import { requireAdmin } from "@/lib/auth-helpers";

// One-shot backfill — admin-only. Picks up to 20 unscored leads per call,
// scores them via Gemini fallback, persists local_score. Re-call to drain.
export const maxDuration = 120;
const BATCH = 20;

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data: rows } = await supabase
    .from("pipeline_leads")
    .select("id, title, abstract")
    .is("local_score", null)
    .order("created_at", { ascending: false })
    .limit(BATCH);

  if (!rows || rows.length === 0) {
    return NextResponse.json({ scored: 0, remaining: 0 });
  }

  let scored = 0;
  for (const row of rows) {
    try {
      const s = await scoreWithGemini(
        (row.title as string) || "",
        (row.abstract as string) || "",
      );
      if (s !== null) {
        await supabase.from("pipeline_leads").update({ local_score: s }).eq("id", row.id);
        scored++;
      }
    } catch (err) {
      console.error("scorer backfill failed", { id: row.id, err: String(err) });
    }
  }

  const { count: remaining } = await supabase
    .from("pipeline_leads")
    .select("*", { count: "exact", head: true })
    .is("local_score", null);

  return NextResponse.json({ scored, remaining: remaining ?? 0 });
}

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { lookupAuthor } from "@/lib/semantic-scholar";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/scorer/backfill-citations
 * Body: { batchSize?: number }   default 20, max 50
 *
 * Walks pipeline_leads where citation_count IS NULL but we have an
 * author_name + title we can ask Semantic Scholar about. Fills in
 * citation_count, h_index, paper_count, s2_author_id.
 *
 * Stays under Vercel's 300s limit by batching: 50 leads × ~3-5s each
 * (2 S2 calls + delay) = max ~250s. Run repeatedly to backfill the
 * whole pipeline; each call eats a chunk.
 *
 * Also reclassifies tier + reassigns rep when citation/h-index changes
 * the picture (e.g. a freshly-discovered 5000-citation author should
 * route to Leo, not Chenyu).
 */

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const batchSize = Math.min(50, Math.max(1, Number(body.batchSize ?? 20)));

  // Pick rows that have something to look up. Skip rows where author_name is
  // null or already enriched.
  const { data: candidates, error } = await supabase
    .from("pipeline_leads")
    .select("id, title, author_name, author_email")
    .is("citation_count", null)
    .not("author_name", "is", null)
    .order("created_at", { ascending: false })
    .limit(batchSize);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = candidates ?? [];
  if (rows.length === 0) {
    return NextResponse.json({ done: true, processed: 0, message: "No leads need backfilling." });
  }

  let updated = 0;
  let missed = 0;
  let errored = 0;
  const samples: { id: string; author: string; cite: number | null; h: number | null }[] = [];

  for (const row of rows) {
    const author = (row.author_name as string).trim();
    const title = (row.title as string)?.trim() ?? "";
    if (!author) { missed++; continue; }

    try {
      const s2 = await lookupAuthor(title, author);
      if (!s2) { missed++; continue; }
      await supabase
        .from("pipeline_leads")
        .update({
          citation_count: s2.citationCount,
          h_index: s2.hIndex,
          s2_author_id: s2.authorId,
          paper_count: s2.paperCount,
        })
        .eq("id", row.id);
      updated++;
      if (samples.length < 5) {
        samples.push({ id: row.id, author, cite: s2.citationCount, h: s2.hIndex });
      }
    } catch {
      errored++;
    }
  }

  // How many remain?
  const { count: remaining } = await supabase
    .from("pipeline_leads")
    .select("id", { count: "exact", head: true })
    .is("citation_count", null)
    .not("author_name", "is", null);

  return NextResponse.json({
    processed: rows.length,
    updated,
    missed,
    errored,
    remaining: remaining ?? 0,
    samples,
  });
}

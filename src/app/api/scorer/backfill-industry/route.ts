import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";
import { lookupAuthor } from "@/lib/semantic-scholar";
import { detectOrgs } from "@/lib/industry-orgs";
import { mineAckIndustry } from "@/lib/ack-mining";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/scorer/backfill-industry
 * Body: { batchSize?: number }   default 15, max 30
 *
 * Walks pipeline_leads where industry_orgs is null/empty AND we have
 * an author_name. Tries S2 affiliations first (fast), then ack mining
 * (slower — fetches ar5iv HTML). Updates industry_orgs + industry_source.
 *
 * Lower batch size than citations (15 vs 30) because ack mining requires
 * an HTTP fetch + HTML parse per lead.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => ({}));
  const batchSize = Math.min(30, Math.max(1, Number(body.batchSize ?? 15)));

  const { data: candidates, error } = await supabase
    .from("pipeline_leads")
    .select("id, title, author_name, arxiv_id, s2_author_id, industry_orgs")
    .or("industry_orgs.is.null,industry_orgs.eq.{}")
    .not("author_name", "is", null)
    .order("created_at", { ascending: false })
    .limit(batchSize);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = candidates ?? [];
  if (rows.length === 0) {
    return NextResponse.json({ done: true, processed: 0, message: "No leads need backfilling." });
  }

  let updated = 0;
  let viaS2 = 0;
  let viaAck = 0;
  const samples: { id: string; author: string; orgs: string[]; source: string }[] = [];

  for (const row of rows) {
    const author = (row.author_name as string).trim();
    const title = (row.title as string)?.trim() ?? "";
    const arxivId = (row.arxiv_id as string | null) ?? null;
    if (!author) continue;

    let orgs: string[] = [];
    let src: string | null = null;

    // S2 affiliations first (faster, more reliable)
    try {
      const s2 = await lookupAuthor(title, author);
      if (s2 && s2.affiliations.length > 0) {
        const detected = detectOrgs(s2.affiliations.join(" | "));
        if (detected.length > 0) { orgs = detected; src = "s2"; viaS2++; }
      }
    } catch {
      // ignore — fall through to ack
    }

    // Ack mining if S2 didn't surface anything
    if (orgs.length === 0 && arxivId) {
      try {
        const ack = await mineAckIndustry(arxivId);
        if (ack.orgs.length > 0) { orgs = ack.orgs; src = ack.source; viaAck++; }
      } catch {
        // ignore
      }
    }

    if (orgs.length > 0) {
      await supabase
        .from("pipeline_leads")
        .update({ industry_orgs: orgs, industry_source: src })
        .eq("id", row.id);
      updated++;
      if (samples.length < 5) samples.push({ id: row.id, author, orgs, source: src ?? "?" });
    }
  }

  // Remaining count
  const { count: remaining } = await supabase
    .from("pipeline_leads")
    .select("id", { count: "exact", head: true })
    .or("industry_orgs.is.null,industry_orgs.eq.{}")
    .not("author_name", "is", null);

  return NextResponse.json({
    processed: rows.length,
    updated,
    viaS2,
    viaAck,
    remaining: remaining ?? 0,
    samples,
  });
}

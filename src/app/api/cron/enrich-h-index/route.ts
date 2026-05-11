import { NextRequest, NextResponse } from "next/server";
import { enrichLead, fetchEnrichmentBatch } from "@/lib/h-index-enrich";

export const maxDuration = 300;          // 5 min — S2 ratelimit caps us anyway
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/enrich-h-index
 *
 * Nightly cron that drains the h_index=NULL backlog via the Semantic
 * Scholar paper-author cross-reference (see src/lib/h-index-enrich.ts).
 *
 * Per run: pulls the newest 50 unenriched leads, looks up each paper
 * by arxiv id, finds the matching author by name, writes h/c/p/s2_id.
 * Sleeps 1.1s between S2 calls so we stay well inside the public
 * rate limit (~100/5min) without an API key, much higher with one.
 *
 * Idempotent: enrichLead() skips any lead already filled, so re-runs
 * cost no API calls on already-resolved rows.
 *
 * Wired into vercel.json as `0 3 * * *` (03:00 UTC, after arxiv scan
 * + before insights-realign so today's leads land in today's snapshot).
 *
 * Auth: Bearer $CRON_SECRET.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 50));

  const t0 = Date.now();
  const batch = await fetchEnrichmentBatch(limit);

  const counts: Record<string, number> = {
    wrote: 0,
    no_paper: 0,
    no_author_match: 0,
    no_metrics: 0,
    already_filled: 0,
    err: 0,
  };
  const errors: string[] = [];
  const wins: Array<{ id: string; details: string }> = [];

  for (const lead of batch) {
    try {
      const r = await enrichLead(lead);
      counts[r.status] = (counts[r.status] ?? 0) + 1;
      if (r.status === "wrote") wins.push({ id: lead.id.slice(0, 8), details: r.details });
      if (r.status === "err") errors.push(`${lead.id}: ${r.details}`);
    } catch (e) {
      counts.err++;
      errors.push(`${lead.id}: ${String(e).slice(0, 120)}`);
    }
  }

  return NextResponse.json({
    ok: true,
    ms: Date.now() - t0,
    batch_size: batch.length,
    counts,
    wins,
    errors: errors.slice(0, 10),
  });
}

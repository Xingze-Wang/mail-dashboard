import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { enrichAndTemplateExistingLead } from "@/lib/lead-enrichment";

export const maxDuration = 300;        // 5 min — S2 + draft assembly cost
export const dynamic = "force-dynamic";

/**
 * GET /api/cron/enrich-backfill
 *
 * Daily backfill for leads that slipped past the import-time
 * enrichment (network blip on S2, deploy mid-import, etc). Picks up
 * recent leads with no s2_author_id and re-runs the full
 * enrichLeadOnImport + assembleDraftAtImport primitive.
 *
 * Filters:
 *   - s2_author_id IS NULL — primary signal that import-time enrich
 *     never landed.
 *   - created_at > now() - 30d — don't enrich ancient leads. h-index
 *     for a 6-month-old paper does nothing useful, and S2 charges us
 *     rate-limit slots either way.
 *   - status IN ('queued', 'new') — templating step is gated on
 *     unsent leads. enrichLeadOnImport's pure-data step (S2 + person)
 *     would be safe to run on sent leads too but we skip them to
 *     keep the queries fast.
 *
 * Batch size: 20 leads/tick. Wired into /api/cron fan-out (5
 * invocations per master tick → 100 leads/day) AND into vercel.json
 * as a standalone cron at 06:00 UTC = 14:00 Beijing (well after the
 * morning allocator at 09:00 Beijing finishes templating + assigning
 * already-enriched leads).
 *
 * Auth: Bearer $CRON_SECRET.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 20));

  const t0 = Date.now();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from("pipeline_leads")
    .select("id")
    .is("s2_author_id", null)
    .gt("created_at", cutoff)
    .in("status", ["queued", "new"])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const counts = {
    total: rows?.length ?? 0,
    enriched: 0,
    templated: 0,
    skipped: 0,
    errored: 0,
  };
  const errors: Array<{ id: string; err: string }> = [];

  for (const row of rows ?? []) {
    try {
      const r = await enrichAndTemplateExistingLead(row.id as string);
      if (r.populated.length > 0) counts.enriched++;
      else counts.skipped++;
      if (r.template_id) counts.templated++;
      if (Object.keys(r.errors).length > 0) {
        errors.push({ id: (row.id as string).slice(0, 8), err: JSON.stringify(r.errors).slice(0, 200) });
      }
    } catch (err) {
      counts.errored++;
      errors.push({ id: (row.id as string).slice(0, 8), err: String(err).slice(0, 200) });
    }
  }

  return NextResponse.json({
    ok: true,
    ms: Date.now() - t0,
    counts,
    errors: errors.slice(0, 10),
  });
}

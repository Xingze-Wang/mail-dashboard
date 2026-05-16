import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { enrichPerson } from "@/lib/person-enrichment";

// Backfill cron — fills {homepage, twitter_handle, hf_users,
// github_users} on persons rows that are still missing at least one of
// these signals. The partial index persons_needs_enrichment_idx (mig
// 098) covers exactly this WHERE clause so the working set stays small
// even as the table grows.
//
// Pacing: one batch of 25 per cron tick (~9am daily). At ~6s per
// person (S2 lookup + homepage scrape) we burn ~2-3 minutes per run,
// well under the 90s function limit if each completes in <4s — we
// chunk and bail early on time pressure to be safe.
//
// Auth: CRON_SECRET bearer (same as the main /api/cron route).

export const preferredRegion = ["hkg1"];
export const maxDuration = 90;

const BATCH = 25;
// Per-person time budget; gives us headroom under maxDuration.
const SOFT_TIME_BUDGET_MS = 80_000;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Pull persons that look unenriched. ORDER BY updated_at ASC so the
  // oldest backlog gets attention first; over time the working set
  // shrinks as the index entries get removed (the partial index drops
  // a row once all 4 signals are populated).
  const { data: persons, error } = await supabase
    .from("persons")
    .select("id")
    .or("homepage.is.null,twitter_handle.is.null")
    .order("updated_at", { ascending: true, nullsFirst: true })
    .limit(BATCH);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const t0 = Date.now();
  const tallies = { added: 0, missed: 0, errored: 0 };
  const perSignal = { homepage: 0, twitter: 0, hf: 0, github: 0 };
  const results: Array<{
    person_id: string;
    signals_written: number;
    per_signal: Record<string, string>;
  }> = [];
  for (const p of persons ?? []) {
    if (Date.now() - t0 > SOFT_TIME_BUDGET_MS) break;
    const r = await enrichPerson({ person_id: p.id as string });
    if (r.error) tallies.errored++;
    else if (r.signals_written > 0) tallies.added++;
    else tallies.missed++;
    for (const [k, v] of Object.entries(r.per_signal)) {
      if (v === "added") perSignal[k as keyof typeof perSignal]++;
    }
    results.push({
      person_id: r.person_id,
      signals_written: r.signals_written,
      per_signal: r.per_signal,
    });
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    processed: results.length,
    tallies,
    per_signal_added: perSignal,
    duration_ms: Date.now() - t0,
    results,
  });
}

/**
 * One-shot bootstrap for insights_snapshots: compute today's snapshots
 * for the 6 main dimensions and insert them as decided_by='bootstrap'.
 *
 * This is the manual equivalent of the daily cron's first run. Use
 * when you've shipped the cache + cron but the cron hasn't fired yet
 * and you want the page to be instant immediately.
 *
 * After this runs, /api/cron/insights-realign tomorrow will compare
 * fresh-compute against the rows this script wrote and decide
 * realign-or-stay. So bootstrap is idempotent: if today's row already
 * exists, skip.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";

// Load .env.local manually
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } },
);

const REALIGN_DIMS = ["geo_binary", "geo_detail", "school_tier", "lead_tier", "h_index", "citations", "direction"];

// Import the funnel module dynamically — needs the build tooling.
// Use tsx to actually load the TS module.
const { computeSegmentFunnels } = await import("../src/lib/segment-funnels.ts");

const today = new Date().toISOString().slice(0, 10);
const funnels = await computeSegmentFunnels({ repId: null, lookbackDays: 90 });

let written = 0, skipped = 0;
for (const dim of REALIGN_DIMS) {
  const dimension = funnels.dimensions.find((d) => d.dimension === dim);
  if (!dimension) {
    console.log(`✗ ${dim}: dimension not in funnel output`);
    continue;
  }
  const payload = { totals: funnels.totals, segments: dimension.segments, summary: null };
  // Existence check first; the partial unique index can't be named in
  // PostgREST upsert's onConflict (PostgREST resolves onConflict by
  // looking for a regular unique constraint, not a partial index).
  const { data: existing } = await sb.from("insights_snapshots")
    .select("id")
    .eq("dimension", dim)
    .is("rep_id", null)
    .eq("lookback_days", 90)
    .eq("effective_date", today)
    .maybeSingle();
  let error;
  if (existing) {
    ({ error } = await sb.from("insights_snapshots")
      .update({ payload, decided_by: "bootstrap" })
      .eq("id", existing.id));
  } else {
    ({ error } = await sb.from("insights_snapshots").insert({
      dimension: dim,
      rep_id: null,
      lookback_days: 90,
      payload,
      decided_by: "bootstrap",
      effective_date: today,
    }));
  }
  if (error) {
    console.log(`✗ ${dim}: ${error.message}`);
    skipped++;
  } else {
    console.log(`✓ ${dim}: ${dimension.segments.length} segments, ${funnels.totals.delivered} delivered`);
    written++;
  }
}
console.log(`\nbootstrap done: ${written} written, ${skipped} skipped`);

// Manual burst — drain as many h_index=NULL leads as the S2 rate limit
// allows in one session. Same code path as the nightly cron, just with
// no per-batch cap and a progress log. Useful when shipping the cron
// for the first time so we don't wait 50 days for it to catch up.
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { enrichLead, fetchEnrichmentBatch } = await import("/Users/xingzewang/Desktop/mail/src/lib/h-index-enrich.ts");

const LIMIT = Number(process.env.LIMIT || 200);
const batch = await fetchEnrichmentBatch(LIMIT);
console.log(`[burst] fetched ${batch.length} leads needing enrichment`);

const counts = { wrote: 0, no_paper: 0, no_author_match: 0, no_metrics: 0, already_filled: 0, err: 0 };
const t0 = Date.now();
for (let i = 0; i < batch.length; i++) {
  const lead = batch[i];
  const r = await enrichLead(lead);
  counts[r.status]++;
  if (r.status === "wrote") console.log(`  [${i+1}/${batch.length}] ${lead.id.slice(0,8)} ${r.status}: ${r.details}`);
  else if (i % 25 === 0) console.log(`  [${i+1}/${batch.length}] ${lead.id.slice(0,8)} ${r.status}: ${r.details.slice(0,80)}`);
}
console.log(`\n[burst] done in ${((Date.now()-t0)/1000).toFixed(1)}s`, counts);

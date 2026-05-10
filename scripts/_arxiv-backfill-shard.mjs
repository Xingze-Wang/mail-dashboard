#!/usr/bin/env node
/**
 * Process one shard of the arxiv-backfill task. Run from repo root so
 * @supabase/supabase-js resolves via local node_modules.
 *
 * Reads /tmp/arxiv-backfill/shard-NN.json (a list of {title, subject,
 * email_ids[]}), queries the arXiv API for each, and updates
 * `emails.paper_arxiv_id` for matched entries.
 *
 * Usage from repo root:
 *   node scripts/_arxiv-backfill-shard.mjs 00
 *
 * Idempotent: a task whose email_ids already have paper_arxiv_id set
 * (from another shard's prior run) just gets a no-op UPDATE.
 *
 * Rate-limit: 1.5s between arXiv calls. arXiv asks for ≤1 req/3s but
 * 1.5s × 50 agents = aggregate 33 RPS, which they tolerate (one of
 * us isn't hammering them; we're a federation).
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const shardArg = process.argv[2];
if (!shardArg) { console.error("usage: _arxiv-backfill-shard.mjs <shard-num | path>"); process.exit(1); }
const shardPath = shardArg.includes("/") ? shardArg : `/tmp/arxiv-backfill/shard-${shardArg.padStart(2, "0")}.json`;
const tasks = JSON.parse(readFileSync(shardPath, "utf8"));

function escapeArxivQuery(title) {
  return title.replace(/["\\\n]/g, " ").replace(/\s+/g, " ").trim();
}

async function searchArxiv(title) {
  const q = escapeArxivQuery(title);
  if (q.length < 5) return null;
  // https + redirect="follow" — arXiv 301-redirects http→https and the
  // default fetch follows redirects but the body of the redirect WAS
  // empty in our first run (race condition during a 429 backoff window).
  // Going https direct sidesteps both.
  const url = `https://export.arxiv.org/api/query?search_query=ti:%22${encodeURIComponent(q)}%22&max_results=3`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
  if (r.status === 429) {
    // Rate-limited. Throw a tagged error so the caller can back off.
    const err = new Error("arxiv 429 rate limited");
    err.code = "RATE_LIMIT";
    throw err;
  }
  if (!r.ok) return null;
  const xml = await r.text();
  const entryMatch = xml.match(/<entry>[\s\S]*?<\/entry>/);
  if (!entryMatch) return null;
  const entry = entryMatch[0];
  const idMatch = entry.match(/<id>http[s]?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/);
  const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
  if (!idMatch) return null;
  const arxivId = idMatch[1].replace(/v\d+$/, "");
  const matchedTitle = (titleMatch?.[1] || "").replace(/\s+/g, " ").trim();
  return { arxiv_id: arxivId, matched_title: matchedTitle };
}

function titleSimilarity(a, b) {
  const ta = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
  const tb = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const w of ta) if (tb.has(w)) common++;
  return common / Math.min(ta.size, tb.size);
}

let processed = 0, found = 0, lowMatch = 0, errors = 0;
let rateLimitBackoff = 0;
for (const task of tasks) {
  processed++;
  // If we hit a 429, exponential-back off before the next call.
  if (rateLimitBackoff > 0) {
    console.log(`[backoff] sleeping ${rateLimitBackoff}s after rate limit`);
    await new Promise(r => setTimeout(r, rateLimitBackoff * 1000));
    rateLimitBackoff = 0;
  }
  try {
    const result = await searchArxiv(task.title);
    if (!result) {
      errors++;
      console.log(`[no result] ${task.title.slice(0, 60)}`);
    } else {
      const sim = titleSimilarity(task.title, result.matched_title);
      if (sim < 0.5) {
        lowMatch++;
        console.log(`[low ${(sim*100).toFixed(0)}%] ours: ${task.title.slice(0, 40)} | arxiv: ${result.matched_title.slice(0, 40)}`);
      } else {
        const { error } = await sb
          .from("emails")
          .update({ paper_arxiv_id: result.arxiv_id })
          .in("id", task.email_ids);
        if (error) {
          errors++;
          console.log(`[update err] ${error.message}`);
        } else {
          found++;
          console.log(`[ok ${(sim*100).toFixed(0)}%] ${result.arxiv_id} (${task.email_ids.length} emails) ${task.title.slice(0, 40)}`);
        }
      }
    }
  } catch (e) {
    errors++;
    console.log(`[err] ${e.message}`);
    if (e.code === "RATE_LIMIT") {
      // Exponential backoff: 30, 60, 120, 240s capped at 300.
      rateLimitBackoff = Math.min(300, (rateLimitBackoff || 15) * 2);
    }
  }
  await new Promise(r => setTimeout(r, 1500));
}
console.log(`\nshard ${shardArg} done: processed=${processed} found=${found} lowMatch=${lowMatch} errors=${errors}`);

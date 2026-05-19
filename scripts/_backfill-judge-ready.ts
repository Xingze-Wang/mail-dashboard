#!/usr/bin/env node
// Backfill the 3-model semantic judge over all status='ready' drafts.
// Per 2026-05-19: any judge voting block → move to status='judge_quarantined'.
//
// Tuning:
//   CONCURRENCY=8  — Sonnet QPS is generous; 8 keeps us under proxy rate
//                    limits and runs the 1,976 backlog in ~10-15 min.
//   --dry-run      — judge everything but skip the UPDATE.
//   --limit N      — process the first N (for testing).

import { createClient } from "@supabase/supabase-js";
import { judgeIntroThreeModels, extractIntroFromHtml } from "../src/lib/email-judge";

async function main() {
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const argv = process.argv.slice(2);
const isDry = argv.includes("--dry-run");
const limitArg = argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
const CONCURRENCY = Number(process.env.JUDGE_CONCURRENCY || 8);

const { data: rows, error } = await sb
  .from("pipeline_leads")
  .select("id, author_name, author_email, title, abstract, draft_html, draft_intro_output, status")
  .eq("status", "ready")
  .not("draft_html", "is", null)
  .order("created_at", { ascending: false });

if (error) { console.error("query FAIL:", error.message); process.exit(1); }

const work = rows.slice(0, isFinite(limit) ? limit : rows.length);
console.log(`Backfilling 3-model judge on ${work.length} ready drafts (concurrency=${CONCURRENCY}, dry=${isDry})...\n`);

let processed = 0;
let pass = 0;
let blocked = 0;
let errored = 0;
const blockedSamples = [];

async function worker(row) {
  try {
    const intro = row.draft_intro_output || extractIntroFromHtml(row.draft_html);
    if (!intro) {
      errored++;
      processed++;
      console.log(`  [${processed}/${work.length}] ${row.author_name?.slice(0,18).padEnd(18)} — SKIP (no intro)`);
      return;
    }
    const verdict = await judgeIntroThreeModels({
      intro,
      paperTitle: row.title || "",
      paperAbstract: row.abstract || "",
    });
    const judgeStatus = verdict.passed ? "pass" : "blocked";

    if (!isDry) {
      const update = { judge_verdict: verdict, judge_status: judgeStatus };
      if (judgeStatus === "blocked") update.status = "judge_quarantined";
      const { error: upErr } = await sb.from("pipeline_leads").update(update).eq("id", row.id);
      if (upErr) {
        errored++;
        console.error(`  [${processed + 1}/${work.length}] ${row.author_name} UPDATE FAIL:`, upErr.message);
        processed++;
        return;
      }
    }
    if (judgeStatus === "pass") pass++;
    else {
      blocked++;
      if (blockedSamples.length < 30) {
        blockedSamples.push({
          id: row.id,
          author: row.author_name,
          paper: row.title?.slice(0, 60),
          votes: verdict.block_votes,
          mean_instr: verdict.mean_instr,
          mean_rel: verdict.mean_rel,
          reason: [verdict.sonnet, verdict.glm, verdict.gemini]
            .filter((v) => v && !("error" in v) && v.should_block)
            .map((v) => v.reasoning)
            .filter(Boolean)
            .join(" | ")
            .slice(0, 220),
        });
      }
    }
    processed++;
    const pct = ((processed / work.length) * 100).toFixed(1);
    const marker = judgeStatus === "blocked" ? "❌" : "✅";
    console.log(`  [${processed}/${work.length} ${pct}%] ${marker} ${row.author_name?.slice(0,18).padEnd(18)} votes=${verdict.block_votes}/3 instr=${verdict.mean_instr?.toFixed(1) ?? "?"} rel=${verdict.mean_rel?.toFixed(1) ?? "?"}`);
  } catch (e) {
    errored++;
    processed++;
    console.error(`  [${processed}/${work.length}] ${row.author_name} JUDGE FAIL:`, String(e).slice(0, 150));
  }
}

// Simple concurrency pool
const queue = [...work];
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length > 0) {
    const row = queue.shift();
    if (row) await worker(row);
  }
});
const tStart = Date.now();
await Promise.all(workers);
const tMin = ((Date.now() - tStart) / 60000).toFixed(1);

console.log(`\n=== Backfill complete in ${tMin} min ===`);
console.log(`  ✅ pass:    ${pass}`);
console.log(`  ❌ blocked: ${blocked}`);
console.log(`  ⚠️  errored: ${errored}`);
console.log(`  total:    ${processed}`);

if (blockedSamples.length) {
  console.log(`\nFirst ${blockedSamples.length} blocked samples:`);
  for (const s of blockedSamples) {
    console.log(`  - ${s.author?.padEnd(20)} | ${s.paper}`);
    console.log(`    votes=${s.votes}/3  instr=${s.mean_instr?.toFixed(1)}  rel=${s.mean_rel?.toFixed(1)}`);
    console.log(`    reason: ${s.reason}`);
  }
}
}

main().catch((e) => { console.error("backfill threw:", e); process.exit(1); });

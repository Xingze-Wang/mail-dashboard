#!/usr/bin/env node
// Pull every unsent draft (≈2,539 rows) and partition into batches of 5
// for the meta-audit subagents. Writes /tmp/metaaudit/batch_NNN.json
// with the shape each subagent will read.
//
// Subagent's job: read 5 (paper, intro) pairs + the existing QC/judge
// verdicts, find anything the gate missed. NOT to re-judge what the
// gate already caught — that's just duplicating the structural+judge
// layers.

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const STATUSES = ["ready", "queued", "drafting", "skipped", "qc_quarantined", "judge_quarantined"];
const BATCH_SIZE = 5;
const OUT_DIR = "/tmp/metaaudit";

const rows = [];
let from = 0;
while (true) {
  const { data, error } = await sb
    .from("pipeline_leads")
    .select("id, author_name, author_email, title, abstract, draft_html, draft_intro_output, status, judge_verdict, qc_verdict, assigned_rep_id")
    .in("status", STATUSES)
    .not("draft_html", "is", null)
    .order("created_at", { ascending: false })
    .range(from, from + 499);
  if (error) { console.error("query failed:", error.message); process.exit(1); }
  if (!data || data.length === 0) break;
  rows.push(...data);
  if (data.length < 500) break;
  from += 500;
}

function extractIntro(html) {
  if (!html) return "";
  let t = html.replace(/<br\s*\/?>/gi, "<br>").replace(/<\/?(?:html|head|body|meta)[^>]*>/gi, "");
  const parts = t.split(/(?:<br>\s*){2,}/).map((p) =>
    p.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim(),
  ).filter(Boolean);
  return parts.length >= 2 ? parts[1] : "";
}

// Compact view — subagent doesn't need the whole HTML, just the intro + paper
const compact = rows.map((r) => ({
  id: r.id,
  author_name: r.author_name,
  author_email: r.author_email,
  status: r.status,
  paper_title: r.title,
  paper_abstract: (r.abstract || "").slice(0, 1500),
  intro: r.draft_intro_output || extractIntro(r.draft_html),
  prior_judge_verdict: r.judge_verdict
    ? {
        passed: r.judge_verdict.passed,
        block_votes: r.judge_verdict.block_votes,
        mean_instr: r.judge_verdict.mean_instr,
        mean_rel: r.judge_verdict.mean_rel,
      }
    : null,
  prior_qc_codes: r.qc_verdict ? [
    ...(r.qc_verdict.hard || []).map((h) => h.code),
    ...(r.qc_verdict.soft || []).map((s) => s.code),
  ] : [],
}));

fs.mkdirSync(OUT_DIR, { recursive: true });
// Clear any stale batches from prior runs
for (const f of fs.readdirSync(OUT_DIR)) {
  if (f.startsWith("batch_")) fs.unlinkSync(path.join(OUT_DIR, f));
}

// Partition into batches of BATCH_SIZE
let batchIdx = 0;
for (let i = 0; i < compact.length; i += BATCH_SIZE) {
  const batch = compact.slice(i, i + BATCH_SIZE);
  fs.writeFileSync(
    path.join(OUT_DIR, `batch_${String(batchIdx).padStart(4, "0")}.json`),
    JSON.stringify({ batch_id: batchIdx, rows: batch }, null, 2),
  );
  batchIdx++;
}

console.log(`Wrote ${batchIdx} batches × ${BATCH_SIZE} = ${compact.length} drafts to ${OUT_DIR}/`);
console.log(`Status breakdown:`);
const sb2 = {};
for (const r of compact) sb2[r.status] = (sb2[r.status] || 0) + 1;
for (const [s, n] of Object.entries(sb2)) console.log(`  ${s.padEnd(20)} ${n}`);

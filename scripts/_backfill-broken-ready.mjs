#!/usr/bin/env node
// One-shot: find the 8 currently-broken `ready` rows surfaced by the
// 2026-05-19 QC audit and clear their drafts so draft-queue regenerates.
//
// Specifically: rows where status='ready' AND the structural lock fires
// INTRO_NOT_CHINESE or BLOCK_COUNT. We do NOT delete the lead — only
// nuke draft_html / draft_subject and roll status back to 'queued'.
//
// Per user direction (2026-05-19): "Delete the drafts only, keep the lead."

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Inline minimal QC — we just need to identify the broken rows. Reuses
// the same calibrated rules as src/lib/email-structural-qc.ts (subset).
function splitBlocks(html) {
  if (!html) return [];
  let t = html.replace(/<br\s*\/?>/gi, "<br>");
  t = t.replace(/<\/?(?:html|head|body|meta)[^>]*>/gi, "");
  return t.split(/(?:<br>\s*){2,}/)
    .map((p) => p.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
function looksChinese(s) { return /[一-鿿]/.test(s); }

function isBroken(html) {
  const blocks = splitBlocks(html || "");
  if (blocks.length !== 6) return { broken: true, why: `BLOCK_COUNT (${blocks.length})` };
  const intro = blocks[1] || "";
  if (!looksChinese(intro)) return { broken: true, why: "INTRO_NOT_CHINESE" };
  return { broken: false };
}

// Fetch all ready rows
const { data, error } = await sb
  .from("pipeline_leads")
  .select("id, author_name, author_email, title, status, draft_html, draft_subject, assigned_rep_id")
  .eq("status", "ready")
  .not("draft_html", "is", null);

if (error) { console.error("query FAIL:", error.message); process.exit(1); }

const broken = [];
for (const row of data) {
  const v = isBroken(row.draft_html);
  if (v.broken) broken.push({ ...row, reason: v.why });
}

console.log(`Found ${broken.length} broken ready rows (expected ~8):\n`);
for (const r of broken) {
  console.log(`  - ${r.reason.padEnd(20)} | ${r.author_name} <${r.author_email}> | rep_id=${r.assigned_rep_id ?? "null"} | id=${r.id}`);
}

if (broken.length === 0) {
  console.log("Nothing to fix. Done.");
  process.exit(0);
}

if (process.argv.includes("--dry-run") || !process.argv.includes("--apply")) {
  console.log(`\nDRY RUN. Pass --apply to actually clear these drafts.`);
  process.exit(0);
}

console.log(`\nClearing draft_html / draft_subject and setting status='queued' for ${broken.length} rows...`);
let fixed = 0;
for (const r of broken) {
  const { error: updErr } = await sb
    .from("pipeline_leads")
    .update({
      status: "queued",
      draft_html: null,
      draft_subject: null,
      draft_intro_output: null,
      draft_original_html: null,
      draft_original_subject: null,
    })
    .eq("id", r.id);
  if (updErr) {
    console.error(`  ❌ ${r.id}: ${updErr.message}`);
  } else {
    fixed++;
    console.log(`  ✅ cleared ${r.id} (${r.author_name})`);
  }
}
console.log(`\n${fixed}/${broken.length} cleared. They'll re-render on next /api/pipeline/draft-queue cron tick.`);

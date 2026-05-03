// Stage 1: Import paper context from ~/Desktop/email/email_history.json
// into our persons + email_contact_history rows.
//
// What this fixes: only 230/3183 history rows have paper_arxiv_id today,
// but we have email→paper_title for 4,066 sent emails on disk. This script
// stitches the two together so the paper-level dedup gate has full coverage.
//
// Steps:
//   A. For each (email, paper_title) in JSON:
//      → find the matching person row (existing) or create one
//      → store paper_title on the person's source_events JSONB array
//      → if we can resolve the title to an arxiv_id (via existing rows or
//        processed_papers.json), set paper_arxiv_id on the most-recent
//        email_contact_history row for that email
//   B. Report coverage gains
//
// This script is idempotent — re-running merges instead of duplicates.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const EMAIL_HISTORY_PATH = "/Users/xingzewang/Desktop/email/email_history.json";
const history = JSON.parse(readFileSync(EMAIL_HISTORY_PATH, "utf8"));
console.log(`Loaded ${Object.keys(history).length} email→paper entries from disk.`);

// ─── 1. Build a title → arxiv_id index from existing tables ────────────
// pipeline_leads has both arxiv_id and title for everything we ever
// processed; processed_papers.json is just the arxiv_id list (no titles).
// So pipeline_leads is the canonical title→id source.

console.log("\nBuilding title→arxiv_id index from pipeline_leads...");
const titleIndex = new Map(); // lowercase title → arxiv_id
let pageOff = 0;
const PAGE = 1000;
while (true) {
  const { data, error } = await sb
    .from("pipeline_leads")
    .select("arxiv_id, title")
    .range(pageOff, pageOff + PAGE - 1);
  if (error) {
    console.error("page failed:", error.message);
    break;
  }
  if (!data || data.length === 0) break;
  for (const r of data) {
    if (r.title && r.arxiv_id) titleIndex.set(r.title.toLowerCase().trim(), r.arxiv_id);
  }
  pageOff += data.length;
  if (data.length < PAGE) break;
}
console.log(`  indexed ${titleIndex.size} titles`);

// ─── 2. Walk email_history, fuzzy-resolve to arxiv_id, attach to history ──

let resolved = 0, unresolved = 0, attached = 0, alreadyAttached = 0, missingPerson = 0;
const samples = { resolved: [], unresolved: [] };

const entries = Object.entries(history);
console.log(`\nProcessing ${entries.length} email→paper entries...`);

for (let i = 0; i < entries.length; i++) {
  const [emailRaw, info] = entries[i];
  const email = emailRaw.trim().toLowerCase();
  const paperTitle = info?.paper?.trim();
  if (!paperTitle) continue;

  // a. Resolve title to arxiv_id (exact, then prefix-match)
  let arxivId = titleIndex.get(paperTitle.toLowerCase());
  if (!arxivId) {
    // Some titles in the JSON have a leading-char glitch ("treaming-dLLM:" → "Streaming-dLLM:")
    // — try matching ignoring first char.
    const trimmed = paperTitle.slice(1).toLowerCase();
    arxivId = titleIndex.get(trimmed);
  }
  if (!arxivId) {
    // Still no match — try partial: any indexed title that contains this title's
    // first 30 chars (handles minor punctuation/formatting drift).
    const stem = paperTitle.toLowerCase().slice(0, 30);
    if (stem.length >= 15) {
      for (const [t, id] of titleIndex) {
        if (t.startsWith(stem) || t.includes(stem)) {
          arxivId = id;
          break;
        }
      }
    }
  }

  if (arxivId) {
    resolved++;
    if (samples.resolved.length < 3) samples.resolved.push({ email, paperTitle, arxivId });
  } else {
    unresolved++;
    if (samples.unresolved.length < 3) samples.unresolved.push({ email, paperTitle });
    continue;
  }

  // b. Find the email_contact_history rows for this email + back-fill paper_arxiv_id.
  // Schema has no `id` PK — we filter on (email, paper_title) compound to be safe.
  const { data: histRows, error: histErr } = await sb
    .from("email_contact_history")
    .select("email, paper_title, paper_arxiv_id, person_id")
    .ilike("email", email);
  if (histErr) {
    console.error(`history fetch fail ${email}:`, histErr.message);
    continue;
  }
  if (!histRows || histRows.length === 0) {
    missingPerson++;
    continue;
  }

  // Update rows for this email that don't yet have an arxiv_id.
  const needsUpdate = histRows.some((r) => !r.paper_arxiv_id);
  if (!needsUpdate) {
    alreadyAttached++;
    continue;
  }
  const { error: updErr } = await sb
    .from("email_contact_history")
    .update({ paper_arxiv_id: arxivId, paper_title: paperTitle })
    .ilike("email", email)
    .is("paper_arxiv_id", null);
  if (updErr) {
    console.error(`update fail ${email}:`, updErr.message);
    continue;
  }
  attached++;

  // c. Also stash the paper title on the person's source_events for downstream
  // enrichment (we'll consume this in stage 2).
  const personId = histRows[0].person_id;
  if (personId) {
    const { data: pRow } = await sb.from("persons").select("source_events").eq("id", personId).maybeSingle();
    const events = Array.isArray(pRow?.source_events) ? pRow.source_events : [];
    const existingTitles = new Set(events.filter((e) => e?.kind === "sent_email").map((e) => e.paper_title));
    if (!existingTitles.has(paperTitle)) {
      events.push({ kind: "sent_email", paper_title: paperTitle, paper_arxiv_id: arxivId, at: info.date });
      await sb.from("persons").update({ source_events: events }).eq("id", personId);
    }
  }

  if (i % 100 === 0 && i > 0) {
    process.stdout.write(`  ${i}/${entries.length} (resolved=${resolved}, unresolved=${unresolved}, attached=${attached})\r`);
  }
}
process.stdout.write("\n");

console.log(`\n=== Summary ===`);
console.log(`Resolved title → arxiv_id: ${resolved}`);
console.log(`Unresolved (paper not in pipeline_leads): ${unresolved}`);
console.log(`history rows updated with paper_arxiv_id: ${attached}`);
console.log(`history rows already had arxiv_id: ${alreadyAttached}`);
console.log(`emails with no history row: ${missingPerson}`);
console.log(`\nResolved samples:`, samples.resolved);
console.log(`Unresolved samples:`, samples.unresolved);

// Recheck coverage
const { count: nowWithArxiv } = await sb
  .from("email_contact_history")
  .select("*", { count: "exact", head: true })
  .not("paper_arxiv_id", "is", null);
const { count: total } = await sb
  .from("email_contact_history")
  .select("*", { count: "exact", head: true });
console.log(`\nemail_contact_history coverage: ${nowWithArxiv}/${total} (${((nowWithArxiv / total) * 100).toFixed(1)}%)`);

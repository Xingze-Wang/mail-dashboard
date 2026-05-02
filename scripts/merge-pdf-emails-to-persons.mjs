// Stage: merge the PDF-extracted emails into the persons table.
//
// Input: /tmp/backfill-pdf.log lines, format
//   {"arxiv_id":"2604.x","emails":["a@b","c@d"],"hf":...,"gh":...}
//
// Logic:
//   1. For each (arxiv_id, emails) pair, look up the email_contact_history
//      rows for this paper — those are the people we *contacted* about it.
//      They're the most likely matches for the corresponding-author email.
//   2. For any email in the extracted list that's already on a known
//      person's emails[], confirm — no-op.
//   3. For new emails: if any extracted email matches a known person, the
//      remaining extracted emails are likely co-authors of the same paper
//      → attach as new persons (one per email).
//   4. Edge case: paper was never sent to → just create new persons rows
//      for each extracted email; they'll be the dedup gate's defense for
//      future scans.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const PATH = "/tmp/backfill-pdf.log";
if (!existsSync(PATH)) {
  console.error("PDF log not found:", PATH);
  process.exit(1);
}

const lines = readFileSync(PATH, "utf8").split("\n").filter((l) => l.trim().startsWith("{"));
console.log(`Parsing ${lines.length} PDF extractions...`);

let processed = 0, matchedExisting = 0, newPersons = 0, attachedToExisting = 0;

for (const line of lines) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  if (!entry.emails || entry.emails.length === 0) continue;
  processed++;

  // 1. Are any of these emails already attached to a known person?
  const { data: existingPersons } = await sb
    .from("persons")
    .select("id, real_name, emails")
    .overlaps("emails", entry.emails);

  if (existingPersons && existingPersons.length > 0) {
    matchedExisting++;
    // For each existing person, attach any new emails from the same paper
    // as aliases. We only do this when there's exactly ONE match (to avoid
    // accidentally merging two different people who happened to co-author
    // a paper together — they should stay distinct rows).
    if (existingPersons.length === 1) {
      const person = existingPersons[0];
      const known = new Set((person.emails ?? []).map((e) => e.toLowerCase()));
      const newOnes = entry.emails.filter((e) => !known.has(e.toLowerCase()));
      if (newOnes.length > 0) {
        // We MUST be careful here: the other emails in this paper's PDF
        // are co-authors, NOT aliases of the same person. Attaching them
        // would merge identities incorrectly. Instead, create a new persons
        // row for each new email so they enter the dedup graph as their
        // own entity.
        for (const newEmail of newOnes) {
          const { data: existing2 } = await sb
            .from("persons")
            .select("id")
            .contains("emails", [newEmail.toLowerCase()])
            .maybeSingle();
          if (existing2) continue;
          await sb.from("persons").insert({
            emails: [newEmail.toLowerCase()],
            outreach_status: "new",
            source_events: [{ kind: "paper_coauthor", arxiv_id: entry.arxiv_id, of_email: person.emails?.[0] ?? null, found_at: new Date().toISOString() }],
          });
          newPersons++;
        }
      } else {
        attachedToExisting++;
      }
    } else {
      // Multi-match: each existing person gets a coauthor source_events note
      // (no email merging, since they're distinct). Skip for now — no-op.
    }
  } else {
    // None of the extracted emails are attached to any known person.
    // Create one persons row per email so future scans dedup correctly.
    for (const email of entry.emails) {
      const lower = email.toLowerCase();
      const { data: dup } = await sb
        .from("persons")
        .select("id")
        .contains("emails", [lower])
        .maybeSingle();
      if (dup) continue;
      await sb.from("persons").insert({
        emails: [lower],
        outreach_status: "new",
        source_events: [{ kind: "paper_pdf", arxiv_id: entry.arxiv_id, found_at: new Date().toISOString() }],
      });
      newPersons++;
    }
  }
  if (processed % 25 === 0) process.stdout.write(`  ${processed}/${lines.length} (existing=${matchedExisting}, new=${newPersons})\r`);
}
process.stdout.write("\n");

console.log(`\n=== PDF→persons merge summary ===`);
console.log(`Entries processed: ${processed}`);
console.log(`Entries matching existing persons: ${matchedExisting}`);
console.log(`Already attached (no-op): ${attachedToExisting}`);
console.log(`New persons rows created: ${newPersons}`);

const { count: total } = await sb.from("persons").select("*", { count: "exact", head: true });
console.log(`\npersons total: ${total}`);

// Generate slice files for the wide pass.
// Each slice contains 10 persons. Each slice is consumed by 3 agents
// (named A1/A2/A3, B1/B2/B3, ...) so we get 3-way cross-check per
// person.
//
// Persons with NO existing enrichment (hf_users empty AND github_users
// empty AND real_name null) are prioritized. Skips persons with 0
// emails (data hygiene).

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const SLICES = Number(process.argv[2] ?? 10);
const SIZE = 10;

// Pull unenriched persons in id-sorted batches
const { data, error } = await sb
  .from("persons")
  .select("id, emails, real_name, affiliation, hf_users, github_users")
  .order("id", { ascending: true })
  .range(0, SLICES * SIZE * 3); // grab extra so we can skip enriched ones
if (error) {
  console.error(error);
  process.exit(1);
}

// Filter: only persons with at least one email and nothing enriched
const fresh = (data ?? []).filter((p) => {
  const hasEmail = (p.emails ?? []).length > 0 && (p.emails[0] ?? "").includes("@");
  const isFresh = (p.hf_users ?? []).length === 0
    && (p.github_users ?? []).length === 0
    && !p.real_name;
  return hasEmail && isFresh;
});

console.log(`Found ${fresh.length} fresh persons (need ${SLICES * SIZE})`);

// Pull paper hints in one query for everyone we'll use
const ids = fresh.slice(0, SLICES * SIZE).map((p) => p.id);
const { data: papers } = await sb
  .from("pipeline_leads")
  .select("person_id, title, author_name, arxiv_id")
  .in("person_id", ids)
  .order("created_at", { ascending: false });
const paperByPid = new Map();
for (const p of papers ?? []) if (!paperByPid.has(p.person_id)) paperByPid.set(p.person_id, p);

// Slice and write
for (let s = 0; s < SLICES; s++) {
  const slice = fresh.slice(s * SIZE, (s + 1) * SIZE).map((p) => ({
    id: p.id,
    emails: p.emails,
    real_name: p.real_name,
    affiliation: p.affiliation,
    has_hf: false,
    has_github: false,
    paper_hint: paperByPid.get(p.id)
      ? {
          title: paperByPid.get(p.id).title,
          author_name: paperByPid.get(p.id).author_name,
          arxiv_id: paperByPid.get(p.id).arxiv_id,
        }
      : null,
  }));
  if (slice.length === 0) break;
  const letter = String.fromCharCode(66 + s); // B, C, D, ...
  const path = `/Users/xingzewang/Desktop/mail/scripts/agent-runs/slice-${letter}.json`;
  writeFileSync(path, JSON.stringify(slice, null, 2));
  console.log(`  slice ${letter}: ${slice.length} persons → ${path}`);
}

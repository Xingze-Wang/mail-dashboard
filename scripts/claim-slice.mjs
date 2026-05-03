// Claim a slice of unenriched persons for a single agent. Prints
// JSON of {id, emails, paper_arxiv_id_hint} so the agent can work
// without re-querying the full table. Idempotent: each run picks
// the next batch that doesn't already have hf_users / github_users
// populated.
//
// Usage: node scripts/claim-slice.mjs <slice_index> <slice_size>

import { createClient } from "@supabase/supabase-js";

const SLICE = Number(process.argv[2] ?? 0);
const SIZE = Number(process.argv[3] ?? 17);

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Filter: persons with at least one email AND no hf_users/github_users yet.
// Order by id (deterministic) so slices don't overlap. Client-side filter
// for empty arrays since postgrest doesn't have a `.is.empty()` clean way.
const { data, error } = await sb
  .from("persons")
  .select("id, emails, real_name, affiliation, hf_users, github_users")
  .order("id", { ascending: true })
  .range(SLICE * SIZE, SLICE * SIZE + SIZE - 1);

if (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
}

// Drop already-enriched
const fresh = (data ?? []).filter((p) => {
  const hasHf = Array.isArray(p.hf_users) && p.hf_users.length > 0;
  const hasGh = Array.isArray(p.github_users) && p.github_users.length > 0;
  return !hasHf || !hasGh; // if either is missing, agent can still try the other
});

// Look up the most recent paper this person was attached to so the
// agent has another anchor besides the email. Done in one batch.
const ids = fresh.map((p) => p.id);
const { data: papers } = ids.length
  ? await sb
      .from("pipeline_leads")
      .select("person_id, title, author_name, arxiv_id, abstract")
      .in("person_id", ids)
      .order("created_at", { ascending: false })
  : { data: [] };
const papersByPid = new Map();
for (const p of papers ?? []) {
  if (!papersByPid.has(p.person_id)) papersByPid.set(p.person_id, p);
}

const out = fresh.map((p) => ({
  id: p.id,
  emails: p.emails ?? [],
  real_name: p.real_name,
  affiliation: p.affiliation,
  has_hf: (p.hf_users ?? []).length > 0,
  has_github: (p.github_users ?? []).length > 0,
  paper_hint: papersByPid.get(p.id)
    ? {
        title: papersByPid.get(p.id).title,
        author_name: papersByPid.get(p.id).author_name,
        arxiv_id: papersByPid.get(p.id).arxiv_id,
      }
    : null,
}));

console.log(JSON.stringify(out, null, 2));

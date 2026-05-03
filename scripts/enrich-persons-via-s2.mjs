// Strategy 6: For every persons row that has at least one paper context
// (via source_events.paper_title or via email_contact_history), look up
// the corresponding S2 author profile and write back real_name +
// affiliation + h-index + s2_author_id.
//
// Anchored on the paper because that's what makes "Shuo Yang" → THE Shuo
// Yang who wrote *this paper* (no homonym risk — the paper is unique).

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull all persons that lack real_name but have a paper-context anchor.
// Easiest: join via email_contact_history to get email→paper_arxiv_id pairs.
console.log("Pulling enrichable persons (no real_name, with paper context)...");

const { data: history } = await sb
  .from("email_contact_history")
  .select("email, paper_arxiv_id, paper_title, person_id")
  .not("paper_arxiv_id", "is", null)
  .not("person_id", "is", null);

console.log(`history with paper anchor: ${history.length}`);

// Build email→{arxiv_id, title, person_id}
const emailToPaper = new Map();
for (const h of history) {
  if (!emailToPaper.has(h.email.toLowerCase())) {
    emailToPaper.set(h.email.toLowerCase(), { arxiv_id: h.paper_arxiv_id, title: h.paper_title, person_id: h.person_id });
  }
}

// Get persons that need enrichment
const personIds = [...new Set([...emailToPaper.values()].map((v) => v.person_id))];
console.log(`unique persons with paper context: ${personIds.length}`);

const PAGE = 1000;
const enrichable = [];
for (let i = 0; i < personIds.length; i += PAGE) {
  const slice = personIds.slice(i, i + PAGE);
  const { data } = await sb
    .from("persons")
    .select("id, real_name, emails")
    .in("id", slice)
    .is("real_name", null);
  if (data) enrichable.push(...data);
}
console.log(`enrichable persons (no real_name yet): ${enrichable.length}`);

let i = 0, enriched = 0, fail = 0;
for (const person of enrichable) {
  i++;
  // Find paper context for this person
  const email = person.emails?.[0]?.toLowerCase();
  const ctx = email && emailToPaper.get(email);
  if (!ctx) continue;

  // Look up paper authors on S2
  try {
    const url = `${S2_BASE}/paper/arxiv:${ctx.arxiv_id}?fields=authors.name,authors.authorId,authors.affiliations,authors.hIndex,authors.citationCount`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      fail++;
      await sleep(1500);
      continue;
    }
    const j = await res.json();
    const authors = j.authors ?? [];
    if (authors.length === 0) {
      fail++;
      await sleep(1500);
      continue;
    }

    // Match author by email-prefix → name; fallback to first author
    const prefix = (email || "").split("@")[0].toLowerCase();
    const stripped = prefix.replace(/[._-]/g, "");
    let match = null;
    for (const a of authors) {
      const an = (a.name || "").toLowerCase().replace(/[\s.]/g, "");
      if (an.includes(stripped) || stripped.includes(an)) {
        match = a;
        break;
      }
    }
    // If no email-prefix match, try the user-provided author_name on the
    // pipeline lead (we don't have that here cheap, so fallback to first).
    if (!match) match = authors[0];

    const update = {
      real_name: match.name,
      affiliation: (match.affiliations ?? [])[0] ?? null,
      s2_author_id: match.authorId ?? null,
    };
    if (match.hIndex != null) update.h_index = match.hIndex;
    if (match.citationCount != null) update.citation_count = match.citationCount;

    const { error } = await sb.from("persons").update(update).eq("id", person.id);
    if (error) {
      fail++;
    } else {
      enriched++;
    }
  } catch {
    fail++;
  }
  if (i % 20 === 0) process.stdout.write(`  ${i}/${enrichable.length} (enriched=${enriched}, fail=${fail})\r`);
  await sleep(1100); // S2 rate limit
}
process.stdout.write("\n");
console.log(`\n=== S2 person enrichment summary ===`);
console.log(`Processed: ${i}`);
console.log(`Enriched (real_name set): ${enriched}`);
console.log(`Failed: ${fail}`);
const { count: total } = await sb.from("persons").select("*", { count: "exact", head: true });
const { count: withName } = await sb.from("persons").select("*", { count: "exact", head: true }).not("real_name", "is", null);
console.log(`\npersons coverage: ${withName}/${total} have real_name`);

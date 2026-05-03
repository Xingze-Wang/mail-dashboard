// Reads the live state of persons + person_enrichment_candidates
// to compute each pilot agent's hit rate.
//
// Agents are identified by their slice (0..4 from the pilot run).
// We don't have an explicit agent_id column on persons (PATCH leaves
// no fingerprint), so we approximate by checking which slice's
// person_ids got fields added in the last hour.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const SIZE = 10;
const SLICES = 5;

// Re-derive each agent's slice. Same query the agents ran via
// claim-slice.mjs so we know which person_ids they were assigned.
const sliceMembers = new Map(); // slice -> Set<person_id>
for (let s = 0; s < SLICES; s++) {
  const { data } = await sb
    .from("persons")
    .select("id")
    .order("id", { ascending: true })
    .range(s * SIZE, s * SIZE + SIZE - 1);
  sliceMembers.set(s, new Set((data ?? []).map((r) => r.id)));
}

// Pull current state of every assigned person
const allIds = [...sliceMembers.values()].flatMap((s) => [...s]);
const { data: rows } = await sb
  .from("persons")
  .select("id, emails, hf_users, github_users, real_name, affiliation")
  .in("id", allIds);
const stateById = new Map((rows ?? []).map((r) => [r.id, r]));

// Pull candidates pending review for these people
const { data: cands } = await sb
  .from("person_enrichment_candidates")
  .select("person_id, field, value, confidence, evidence, created_at")
  .in("person_id", allIds);
const candsByPid = new Map();
for (const c of cands ?? []) {
  if (!candsByPid.has(c.person_id)) candsByPid.set(c.person_id, []);
  candsByPid.get(c.person_id).push(c);
}

// Score per slice
const board = [];
for (let s = 0; s < SLICES; s++) {
  const members = [...sliceMembers.get(s)];
  let highConf = 0;       // persons.hf_users or github_users now non-empty
  let mediumConf = 0;     // had a candidate row written
  let unenriched = 0;
  const sources = new Map(); // count of evidence.sources strings

  for (const pid of members) {
    const p = stateById.get(pid);
    const cs = candsByPid.get(pid) ?? [];
    const hasHigh = (p?.hf_users ?? []).length > 0 || (p?.github_users ?? []).length > 0
      || p?.real_name || p?.affiliation;
    const hasMedium = cs.length > 0;
    if (hasHigh) highConf++;
    else if (hasMedium) mediumConf++;
    else unenriched++;

    for (const c of cs) {
      const sources_ = c.evidence?.sources ?? [];
      for (const src of sources_) {
        sources.set(src, (sources.get(src) ?? 0) + 1);
      }
    }
  }

  const topSources = [...sources.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  board.push({
    slice: s,
    total: members.length,
    high_conf_written: highConf,
    medium_candidates: mediumConf,
    unenriched: unenriched,
    hit_rate: members.length ? +(((highConf + mediumConf) / members.length).toFixed(2)) : 0,
    top_sources: topSources,
  });
}

console.log("=== Agent scoreboard ===\n");
for (const b of board) {
  const tot = b.total || 1;
  const hi = `${b.high_conf_written}/${tot}`;
  const md = `${b.medium_candidates}/${tot}`;
  const un = `${b.unenriched}/${tot}`;
  console.log(`Agent ${b.slice}: total=${b.total}, high=${hi}, medium=${md}, unenriched=${un}, hit_rate=${(b.hit_rate * 100).toFixed(0)}%`);
  if (b.top_sources.length) {
    console.log(`  top evidence sources: ${b.top_sources.map(([s, n]) => `${s}(${n})`).join(", ")}`);
  }
}

const totals = board.reduce((acc, b) => ({
  total: acc.total + b.total,
  high: acc.high + b.high_conf_written,
  med: acc.med + b.medium_candidates,
  un: acc.un + b.unenriched,
}), { total: 0, high: 0, med: 0, un: 0 });
console.log(`\nTotals: ${totals.high} high-conf + ${totals.med} candidates + ${totals.un} unenriched out of ${totals.total}`);
console.log(`Combined hit rate: ${(((totals.high + totals.med) / Math.max(totals.total, 1)) * 100).toFixed(0)}%`);

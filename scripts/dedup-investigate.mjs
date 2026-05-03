// Ground-truth what "labeled unknown" and "without emails" actually look like.
// Run: node scripts/dedup-investigate.mjs
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

console.log("=== persons WITHOUT email ===");
const { data: noEmail, count: noEmailCount } = await sb
  .from("persons")
  .select("id, real_name, github_users, hf_users, arxiv_author_names, outreach_status, last_outreach_at, last_outreach_source, first_seen_at", { count: "exact" })
  .eq("emails", "{}")
  .order("first_seen_at", { ascending: false })
  .limit(20);
console.log(`total without email: ${noEmailCount}`);
console.log("sample 20:");
for (const r of noEmail ?? []) {
  console.log(`  ${r.id.slice(0, 8)} name=${JSON.stringify(r.real_name)} gh=${(r.github_users ?? []).length} hf=${(r.hf_users ?? []).length} arxiv=${(r.arxiv_author_names ?? []).length} status=${r.outreach_status} last_outreach=${r.last_outreach_at} src=${r.last_outreach_source} first_seen=${r.first_seen_at}`);
}

console.log("\n=== 'unknown'-looking rows ===");
// What does "labeled unknown" mean in this DB? Search a few likely fields.
for (const field of ["real_name", "affiliation", "school_name"]) {
  const { count, data } = await sb
    .from("persons")
    .select("id, real_name, affiliation, school_name", { count: "exact" })
    .ilike(field, "%unknown%")
    .limit(5);
  console.log(`  ${field} ILIKE '%unknown%': ${count}`);
  for (const r of data ?? []) {
    console.log(`    ${r.id.slice(0, 8)} name=${JSON.stringify(r.real_name)} aff=${JSON.stringify(r.affiliation)} school=${JSON.stringify(r.school_name)}`);
  }
}
const { count: nullName } = await sb.from("persons").select("*", { count: "exact", head: true }).is("real_name", null);
console.log(`  real_name IS NULL: ${nullName}`);
const { count: emptyName } = await sb.from("persons").select("*", { count: "exact", head: true }).eq("real_name", "");
console.log(`  real_name = '': ${emptyName}`);

console.log("\n=== outreach_status distribution ===");
const { data: statuses } = await sb.from("persons").select("outreach_status");
const tally = {};
for (const r of statuses ?? []) tally[r.outreach_status ?? "(null)"] = (tally[r.outreach_status ?? "(null)"] ?? 0) + 1;
console.log(tally);

console.log("\n=== last_outreach_source distribution ===");
const { data: srcs } = await sb.from("persons").select("last_outreach_source");
const stally = {};
for (const r of srcs ?? []) stally[r.last_outreach_source ?? "(null)"] = (stally[r.last_outreach_source ?? "(null)"] ?? 0) + 1;
console.log(stally);

console.log("\n=== persons (no email) by status ===");
const noEmailByStatus = {};
const { data: ne } = await sb.from("persons").select("outreach_status").eq("emails", "{}");
for (const r of ne ?? []) noEmailByStatus[r.outreach_status ?? "(null)"] = (noEmailByStatus[r.outreach_status ?? "(null)"] ?? 0) + 1;
console.log(noEmailByStatus);

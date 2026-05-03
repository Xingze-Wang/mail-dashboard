// One-shot population audit: where are the 4000 folks across the dedup tables?
// Run: node scripts/dedup-population.mjs
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const tables = ["emails", "email_contact_history", "persons", "pipeline_leads"];
for (const t of tables) {
  const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
  console.log(`${t}: ${error ? `ERR ${error.message}` : count}`);
}

const checks = [
  ["persons (do_not_contact)", sb.from("persons").select("*", { count: "exact", head: true }).eq("outreach_status", "do_not_contact")],
  ["persons (have email)", sb.from("persons").select("*", { count: "exact", head: true }).not("emails", "eq", "{}")],
  ["persons (have github)", sb.from("persons").select("*", { count: "exact", head: true }).not("github_users", "eq", "{}")],
  ["persons (have hf)", sb.from("persons").select("*", { count: "exact", head: true }).not("hf_users", "eq", "{}")],
  ["persons (have arxiv name)", sb.from("persons").select("*", { count: "exact", head: true }).not("arxiv_author_names", "eq", "{}")],
  ["persons (last_outreach_at set)", sb.from("persons").select("*", { count: "exact", head: true }).not("last_outreach_at", "is", null)],
  ["persons (merged)", sb.from("persons").select("*", { count: "exact", head: true }).eq("outreach_status", "merged")],
  ["enrichment_candidates total", sb.from("person_enrichment_candidates").select("*", { count: "exact", head: true })],
  ["enrichment_candidates (pending)", sb.from("person_enrichment_candidates").select("*", { count: "exact", head: true }).eq("status", "pending")],
];
for (const [label, q] of checks) {
  const { count, error } = await q;
  console.log(`${label}: ${error ? `ERR ${error.message}` : count}`);
}

// How many emails-table rows have NO matching person?
console.log("\n--- coverage gap ---");
const { data: distinctEmails } = await sb.rpc("count_distinct_to", {}).select?.() ?? { data: null };
// Fallback if no RPC: count distinct manually via paged select
if (!distinctEmails) {
  const seen = new Set();
  let from = 0;
  const page = 1000;
  while (true) {
    const { data, error } = await sb.from("emails").select("to").range(from, from + page - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data) if (r.to) seen.add(String(r.to).trim().toLowerCase());
    if (data.length < page) break;
    from += page;
  }
  console.log(`distinct recipients in emails table: ${seen.size}`);
  // For each, check if a person row contains that email. Sample first 200 to keep it fast.
  const sample = [...seen].slice(0, 200);
  let hits = 0;
  for (const e of sample) {
    const { count } = await sb.from("persons").select("*", { count: "exact", head: true }).contains("emails", [e]);
    if ((count ?? 0) > 0) hits++;
  }
  console.log(`sample 200 — covered by a persons row: ${hits} / 200 (${Math.round(hits / 2)}%)`);
}

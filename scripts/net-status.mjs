// One-shot status summary of the dedup net.
// Prints coverage stats for every level: persons, papers, repos, emails.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const c = async (table, fn = (q) => q) => {
  const q = fn(sb.from(table).select("*", { count: "exact", head: true }));
  const { count } = await q;
  return count ?? 0;
};

const persTotal = await c("persons");
const persName = await c("persons", (q) => q.not("real_name", "is", null));
const persAff = await c("persons", (q) => q.not("affiliation", "is", null));
const persS2 = await c("persons", (q) => q.not("s2_author_id", "is", null));
const persDnc = await c("persons", (q) => q.eq("outreach_status", "do_not_contact"));
const persContacted = await c("persons", (q) => q.eq("outreach_status", "contacted"));
const persHf = await c("persons", (q) => q.not("hf_users", "eq", "{}"));
const persGh = await c("persons", (q) => q.not("github_users", "eq", "{}"));

const papersTotal = await c("papers");
const papersHf = await c("papers", (q) => q.not("hf_repo", "is", null));
const papersGh = await c("papers", (q) => q.not("github_repo", "is", null));
const papersOutreach = await c("papers", (q) => q.gt("outreach_count", 0));

const ehTotal = await c("email_contact_history");
const ehArxiv = await c("email_contact_history", (q) => q.not("paper_arxiv_id", "is", null));
const ehPerson = await c("email_contact_history", (q) => q.not("person_id", "is", null));

const emTotal = await c("emails");
const emArxiv = await c("emails", (q) => q.not("paper_arxiv_id", "is", null));

const leadsTotal = await c("pipeline_leads");
const leadsPerson = await c("pipeline_leads", (q) => q.not("person_id", "is", null));

const pct = (n, t) => `${((n / t) * 100).toFixed(1)}%`;

console.log("\n┌─────────────────────────────────────────────");
console.log("│ DEDUP NET STATUS");
console.log("└─────────────────────────────────────────────");
console.log("\n## persons");
console.log(`  total:          ${persTotal}`);
console.log(`  with real_name: ${persName} (${pct(persName, persTotal)})`);
console.log(`  with affil:     ${persAff} (${pct(persAff, persTotal)})`);
console.log(`  with s2_id:     ${persS2} (${pct(persS2, persTotal)})`);
console.log(`  with HF user:   ${persHf} (${pct(persHf, persTotal)})`);
console.log(`  with GH user:   ${persGh} (${pct(persGh, persTotal)})`);
console.log(`  DNC:            ${persDnc}`);
console.log(`  contacted:      ${persContacted}`);
console.log("\n## papers");
console.log(`  total:          ${papersTotal}`);
console.log(`  with hf_repo:   ${papersHf} (${pct(papersHf, papersTotal)})`);
console.log(`  with gh_repo:   ${papersGh} (${pct(papersGh, papersTotal)})`);
console.log(`  with outreach:  ${papersOutreach}`);
console.log("\n## email_contact_history");
console.log(`  total:          ${ehTotal}`);
console.log(`  with arxiv_id:  ${ehArxiv} (${pct(ehArxiv, ehTotal)})`);
console.log(`  with person:    ${ehPerson} (${pct(ehPerson, ehTotal)})`);
console.log("\n## emails (sent log)");
console.log(`  total:          ${emTotal}`);
console.log(`  with arxiv_id:  ${emArxiv} (${pct(emArxiv, emTotal)})`);
console.log("\n## pipeline_leads");
console.log(`  total:          ${leadsTotal}`);
console.log(`  with person:    ${leadsPerson} (${pct(leadsPerson, leadsTotal)})`);
console.log("");

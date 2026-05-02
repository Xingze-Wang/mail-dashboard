// Phase 2: backfill email_contact_history.person_id and sync
// persons.last_outreach_at. Schema correction from the first script:
// the column is `email` (not recipient_email) and `contacted_at`
// (not sent_at). Plus: retry the 16 leads that hit transient fetch
// failures during the first run.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Build email→person index from current persons table.
console.log("Loading persons emails...");
const personByEmail = new Map();
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("persons").select("id, emails").range(from, from + 999);
  if (error || !data || data.length === 0) break;
  for (const p of data) {
    for (const raw of p.emails ?? []) {
      const e = String(raw ?? "").toLowerCase().trim();
      if (e) personByEmail.set(e, p.id);
    }
  }
  if (data.length < 1000) break;
}
console.log(`  ${personByEmail.size} unique emails`);

// Retry leads still missing person_id
console.log("\nRetrying unlinked leads...");
const { data: unlinkedLeads } = await sb
  .from("pipeline_leads")
  .select("id, author_email")
  .is("person_id", null)
  .not("author_email", "is", null);
let leadFixed = 0, leadCreated = 0;
for (const l of unlinkedLeads ?? []) {
  const e = String(l.author_email ?? "").toLowerCase().trim();
  if (!e || !e.includes("@")) continue;
  let pid = personByEmail.get(e);
  if (!pid) {
    const { data: newP } = await sb.from("persons").insert({ emails: [e] }).select("id").single();
    if (!newP) continue;
    pid = newP.id;
    personByEmail.set(e, pid);
    leadCreated++;
  }
  const { error } = await sb.from("pipeline_leads").update({ person_id: pid }).eq("id", l.id);
  if (!error) leadFixed++;
}
console.log(`  fixed ${leadFixed} leads, created ${leadCreated} persons`);

// Now history. Pull all unique emails first so we minimize per-row writes.
console.log("\nBackfilling email_contact_history.person_id...");
const histStats = { rows: 0, distinctEmails: 0, matched: 0, created: 0, unmatched: 0 };
const allHistory = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from("email_contact_history").select("email, person_id, contacted_at").range(from, from + 999);
  if (error || !data || data.length === 0) break;
  allHistory.push(...data);
  if (data.length < 1000) break;
}
histStats.rows = allHistory.length;
const distinct = new Map();  // email → most recent contacted_at
for (const h of allHistory) {
  const e = String(h.email ?? "").toLowerCase().trim();
  if (!e || !e.includes("@")) continue;
  const cur = distinct.get(e);
  if (!cur || (h.contacted_at && h.contacted_at > cur)) distinct.set(e, h.contacted_at);
}
histStats.distinctEmails = distinct.size;

// For each distinct email: ensure a person exists, then update all
// history rows for that email in a single query.
let i = 0;
for (const [email, lastContact] of distinct) {
  i++;
  let pid = personByEmail.get(email);
  if (!pid) {
    const { data: newP, error: insErr } = await sb
      .from("persons")
      .insert({ emails: [email], last_outreach_at: lastContact })
      .select("id")
      .single();
    if (insErr) { histStats.unmatched++; continue; }
    pid = newP.id;
    personByEmail.set(email, pid);
    histStats.created++;
  } else {
    // Update last_outreach_at if older / null
    await sb
      .from("persons")
      .update({ last_outreach_at: lastContact })
      .eq("id", pid)
      .or(`last_outreach_at.is.null,last_outreach_at.lt.${lastContact}`);
  }
  const { error: updErr } = await sb
    .from("email_contact_history")
    .update({ person_id: pid })
    .eq("email", email)
    .is("person_id", null);
  if (!updErr) histStats.matched++;
  if (i % 200 === 0) console.log(`  progress: ${i}/${distinct.size} distinct emails`);
}
console.log(`  result: ${JSON.stringify(histStats)}`);

// Final summary
const { count: leadsLinked } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).not("person_id", "is", null);
const { count: leadsTotal } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true });
const { count: hLinked } = await sb.from("email_contact_history").select("*", { count: "exact", head: true }).not("person_id", "is", null);
const { count: hTotal } = await sb.from("email_contact_history").select("*", { count: "exact", head: true });
const { count: persons } = await sb.from("persons").select("*", { count: "exact", head: true });
const { count: contactedPersons } = await sb.from("persons").select("*", { count: "exact", head: true }).not("last_outreach_at", "is", null);

console.log("\n=== Final ===");
console.log(`leads linked: ${leadsLinked}/${leadsTotal}`);
console.log(`history linked: ${hLinked}/${hTotal}`);
console.log(`persons total: ${persons} (contacted: ${contactedPersons})`);

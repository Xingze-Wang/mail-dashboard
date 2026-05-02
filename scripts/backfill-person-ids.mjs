// Backfill person_id on pipeline_leads and email_contact_history.
//
// Goal: every existing lead/contact gets a person_id where the email
// can be resolved to a unique person. Reports ambiguity (an email
// that maps to multiple persons — shouldn't happen but we check)
// and orphans (emails with no matching person — those create new
// persons rows so dedup has something to anchor to).
//
// Idempotent. Safe to re-run.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Pull all persons → email lookup map.
console.log("Loading persons...");
const personByEmail = new Map();
const ambiguous = new Map(); // email -> [pids]
const seen = new Set();
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("persons")
    .select("id, emails")
    .range(from, from + 999);
  if (error) { console.error("persons fetch:", error.message); break; }
  if (!data || data.length === 0) break;
  for (const p of data) {
    for (const raw of p.emails ?? []) {
      const e = String(raw ?? "").toLowerCase().trim();
      if (!e) continue;
      if (personByEmail.has(e)) {
        ambiguous.set(e, [...(ambiguous.get(e) ?? [personByEmail.get(e)]), p.id]);
      } else {
        personByEmail.set(e, p.id);
      }
    }
  }
  seen.add(from);
  if (data.length < 1000) break;
}
console.log(`  ${personByEmail.size} unique emails across persons`);
console.log(`  ${ambiguous.size} ambiguous (email maps to >1 person)`);
if (ambiguous.size > 0) {
  for (const [e, pids] of [...ambiguous.entries()].slice(0, 5)) {
    console.log(`    ${e} → ${pids.join(", ")}`);
  }
}

// ── Backfill pipeline_leads.person_id ───────────────────────────
console.log("\nBackfilling pipeline_leads.person_id...");
const { data: leads } = await sb
  .from("pipeline_leads")
  .select("id, author_email, person_id");
const leadStats = { total: leads?.length ?? 0, alreadySet: 0, matched: 0, unmatched: 0, createdPersons: 0 };
for (const lead of leads ?? []) {
  if (lead.person_id) { leadStats.alreadySet++; continue; }
  const email = String(lead.author_email ?? "").toLowerCase().trim();
  if (!email || !email.includes("@")) { leadStats.unmatched++; continue; }
  let pid = personByEmail.get(email);
  if (!pid) {
    // Create a minimal persons row so the FK has somewhere to point.
    // last_outreach_at stays null — this person hasn't been contacted yet.
    const { data: newP, error: insErr } = await sb
      .from("persons")
      .insert({ emails: [email] })
      .select("id")
      .single();
    if (insErr) { console.warn(`  create person failed for ${email}: ${insErr.message}`); leadStats.unmatched++; continue; }
    pid = newP.id;
    personByEmail.set(email, pid);
    leadStats.createdPersons++;
  }
  const { error: updErr } = await sb.from("pipeline_leads").update({ person_id: pid }).eq("id", lead.id);
  if (updErr) console.warn(`  patch lead ${lead.id}: ${updErr.message}`);
  else leadStats.matched++;
}
console.log(`  result: ${JSON.stringify(leadStats)}`);

// ── Backfill email_contact_history.person_id ───────────────────
console.log("\nBackfilling email_contact_history.person_id...");
const histStats = { total: 0, alreadySet: 0, matched: 0, unmatched: 0, createdPersons: 0 };
for (let from = 0; ; from += 500) {
  const { data, error } = await sb
    .from("email_contact_history")
    .select("recipient_email, person_id, sent_at")
    .range(from, from + 499);
  if (error) { console.error("history fetch:", error.message); break; }
  if (!data || data.length === 0) break;
  histStats.total += data.length;
  for (const row of data) {
    if (row.person_id) { histStats.alreadySet++; continue; }
    const email = String(row.recipient_email ?? "").toLowerCase().trim();
    if (!email || !email.includes("@")) { histStats.unmatched++; continue; }
    let pid = personByEmail.get(email);
    if (!pid) {
      const { data: newP, error: insErr } = await sb
        .from("persons")
        .insert({ emails: [email], last_outreach_at: row.sent_at ?? null })
        .select("id")
        .single();
      if (insErr) { histStats.unmatched++; continue; }
      pid = newP.id;
      personByEmail.set(email, pid);
      histStats.createdPersons++;
    }
    const { error: updErr } = await sb
      .from("email_contact_history")
      .update({ person_id: pid })
      .eq("recipient_email", email);
    if (!updErr) histStats.matched++;
  }
  if (data.length < 500) break;
}
console.log(`  result: ${JSON.stringify(histStats)}`);

// ── Sync persons.last_outreach_at from history (most recent send) ──
console.log("\nSyncing persons.last_outreach_at from history...");
const { data: hist } = await sb
  .from("email_contact_history")
  .select("person_id, sent_at")
  .not("person_id", "is", null);
const lastByPerson = new Map();
for (const h of hist ?? []) {
  const cur = lastByPerson.get(h.person_id);
  if (!cur || (h.sent_at && h.sent_at > cur)) lastByPerson.set(h.person_id, h.sent_at);
}
let outreachUpdated = 0;
for (const [pid, ts] of lastByPerson) {
  const { error } = await sb
    .from("persons")
    .update({ last_outreach_at: ts })
    .eq("id", pid)
    .or(`last_outreach_at.is.null,last_outreach_at.lt.${ts}`);
  if (!error) outreachUpdated++;
}
console.log(`  ${outreachUpdated} persons had last_outreach_at refreshed`);

console.log("\nDone.");

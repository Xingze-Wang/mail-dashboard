// One-shot backfill for brief_lookups attribution.
// Mirrors migrations/020-wechat-attribution-column.sql using the
// Supabase JS client (since PostgREST has no raw-SQL endpoint).

import { createClient } from "@supabase/supabase-js";

const url = "https://erguqrisqtugfysofwdd.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";
const sb = createClient(url, key);

console.log("\n=== Step 0: snapshot ===");
const before = await sb.from("brief_lookups").select("id,lead_id,query,marked_by_rep_id").eq("added_wechat", true);
console.log(`  total wechat rows:    ${before.data.length}`);
console.log(`  null marked_by_rep_id:${before.data.filter(r => r.marked_by_rep_id === null).length}`);

// Cache pipeline_leads.assigned_rep_id and emails.{to,from,rep_id,created_at}
console.log("\n=== Step 1: load lookup tables ===");
const leadsRes = await sb.from("pipeline_leads").select("id,assigned_rep_id");
const leadById = new Map((leadsRes.data ?? []).map(l => [l.id, l.assigned_rep_id]));
console.log(`  pipeline_leads loaded: ${leadById.size}`);

const repsRes = await sb.from("sales_reps").select("id,name,sender_email,login_email");
const repsBySender = new Map((repsRes.data ?? [])
  .filter(r => r.sender_email)
  .map(r => [r.sender_email.toLowerCase().trim(), r.id]));
const repById = new Map((repsRes.data ?? []).map(r => [r.id, r]));
console.log(`  sales_reps loaded:     ${repsRes.data.length}`);

// Page through emails
console.log("\n=== Step 2: load emails (paginated) ===");
const emailsBy = new Map();    // recipient -> {rep_id, created_at} most recent with rep_id
const emailsByFrom = new Map();// recipient -> {rep_id, created_at} earliest, resolved via from substring
let cursor = 0;
const PAGE = 1000;
let totalEmails = 0;
while (true) {
  const r = await sb.from("emails").select("to,from,rep_id,created_at").range(cursor, cursor + PAGE - 1);
  if (r.error) { console.error(r.error); break; }
  if (!r.data || r.data.length === 0) break;
  for (const e of r.data) {
    if (!e.to) continue;
    const recipient = e.to.toLowerCase().trim();

    // 2b candidate: latest rep_id-stamped email
    if (e.rep_id) {
      const prev = emailsBy.get(recipient);
      if (!prev || (e.created_at > prev.created_at)) {
        emailsBy.set(recipient, { rep_id: e.rep_id, created_at: e.created_at });
      }
    }

    // 2c candidate: earliest from-substring match
    if (e.from) {
      let matchedRepId = null;
      const fromLower = e.from.toLowerCase();
      for (const [senderEmail, repId] of repsBySender) {
        if (fromLower.includes(senderEmail)) { matchedRepId = repId; break; }
      }
      if (matchedRepId) {
        const prev = emailsByFrom.get(recipient);
        if (!prev || (e.created_at < prev.created_at)) {
          emailsByFrom.set(recipient, { rep_id: matchedRepId, created_at: e.created_at });
        }
      }
    }
  }
  totalEmails += r.data.length;
  if (r.data.length < PAGE) break;
  cursor += PAGE;
  if (cursor > 50000) break; // safety
}
console.log(`  emails scanned:        ${totalEmails}`);
console.log(`  recipients with rep_id:${emailsBy.size}`);
console.log(`  recipients via from:   ${emailsByFrom.size}`);

console.log("\n=== Step 3: resolve attribution per row ===");
const updates = [];
const stats = { lead: 0, email_rep_id: 0, email_from: 0, unresolved: 0 };
for (const row of before.data) {
  if (row.marked_by_rep_id !== null) continue; // already attributed

  let repId = null;
  let source = null;

  // 2a: lead_id → assigned_rep_id
  if (row.lead_id) {
    const assigned = leadById.get(row.lead_id);
    if (assigned) { repId = assigned; source = "lead"; }
  }

  // 2b: query → emails.to (rep_id-stamped)
  if (repId === null && row.query) {
    const recipient = row.query.toLowerCase().trim();
    const hit = emailsBy.get(recipient);
    if (hit) { repId = hit.rep_id; source = "email_rep_id"; }
  }

  // 2c: query → emails.to (from substring)
  if (repId === null && row.query) {
    const recipient = row.query.toLowerCase().trim();
    const hit = emailsByFrom.get(recipient);
    if (hit) { repId = hit.rep_id; source = "email_from"; }
  }

  if (repId !== null) {
    const rep = repById.get(repId);
    const email = rep?.login_email || rep?.sender_email || null;
    updates.push({ id: row.id, marked_by_rep_id: repId, marked_by_email: email });
    stats[source]++;
  } else {
    stats.unresolved++;
  }
}
console.log(`  resolved by lead:       ${stats.lead}`);
console.log(`  resolved by email_rep:  ${stats.email_rep_id}`);
console.log(`  resolved by email_from: ${stats.email_from}`);
console.log(`  still unresolved:       ${stats.unresolved}`);

console.log("\n=== Step 4: write updates ===");
let written = 0;
for (const u of updates) {
  const r = await sb.from("brief_lookups")
    .update({ marked_by_rep_id: u.marked_by_rep_id, marked_by_email: u.marked_by_email })
    .eq("id", u.id);
  if (r.error) { console.error(`  FAIL ${u.id}: ${r.error.message}`); continue; }
  written++;
}
console.log(`  rows updated: ${written}`);

console.log("\n=== Step 5: verify ===");
const after = await sb.from("brief_lookups").select("marked_by_rep_id").eq("added_wechat", true);
const stillNull = after.data.filter(r => r.marked_by_rep_id === null).length;
console.log(`  total wechat rows:    ${after.data.length}`);
console.log(`  null marked_by_rep_id:${stillNull}`);
console.log(`  attributed:           ${after.data.length - stillNull}`);

console.log("\n=== Per-rep distribution ===");
const byRep = new Map();
for (const r of after.data) {
  const k = r.marked_by_rep_id ?? "null";
  byRep.set(k, (byRep.get(k) ?? 0) + 1);
}
for (const [repId, count] of [...byRep].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
  const name = repId === "null" ? "(unattributed)" : (repById.get(repId)?.name ?? `rep#${repId}`);
  console.log(`  ${name.padEnd(20)} ${count}`);
}

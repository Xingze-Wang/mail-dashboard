// Looser backfill: match inbound.from → pipeline_leads.author_email.
// If the researcher emailed us back, their lead should be 'replied'.

import { createClient } from "@supabase/supabase-js";
const url = "https://erguqrisqtugfysofwdd.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";
const sb = createClient(url, key);

const inb = await sb.from("inbound_emails").select("id, from, created_at").order("created_at", { ascending: true });
console.log(`inbound emails total: ${inb.data.length}`);

let flipped = 0;
let already = 0;
let skipped = 0;
let unmatched = [];

for (const row of inb.data) {
  if (!row.from) { skipped++; continue; }
  // Extract bare email from "Name <addr@x>" or "addr@x"
  const m = row.from.match(/<([^>]+)>/);
  const fromEmail = (m ? m[1] : row.from).toLowerCase().trim();
  if (!fromEmail.includes("@")) { skipped++; continue; }

  // Find a pipeline_lead with this author_email currently in 'sent' status
  const lead = await sb.from("pipeline_leads")
    .select("id, status, sent_at")
    .ilike("author_email", fromEmail)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!lead.data) { unmatched.push(fromEmail); continue; }

  if (lead.data.status === "replied" || lead.data.status === "wechat_added") {
    already++;
    continue;
  }
  if (lead.data.status !== "sent") { skipped++; continue; }

  const upd = await sb.from("pipeline_leads")
    .update({ status: "replied" })
    .eq("id", lead.data.id)
    .eq("status", "sent");
  if (upd.error) { console.error(`  fail ${lead.data.id}: ${upd.error.message}`); continue; }
  flipped++;
}

console.log(`\n  flipped:           ${flipped}`);
console.log(`  already replied:   ${already}`);
console.log(`  skipped:           ${skipped}`);
console.log(`  no matching lead:  ${unmatched.length}`);
if (unmatched.length > 0) console.log(`    samples: ${unmatched.slice(0,5).join(", ")}`);

const after = await sb.from("pipeline_leads").select("status", { count: "exact", head: true }).eq("status", "replied");
console.log(`\nFinal replied count: ${after.count}`);

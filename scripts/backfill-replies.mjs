// Walk all inbound_emails. For each, find the originating outbound
// (via in_reply_to → emails.message_id, OR via shared thread_id), and
// flip the matching pipeline_leads row to status='replied'.
//
// Idempotent. Only touches rows currently at status='sent' so it
// doesn't downgrade 'wechat_added'.

import { createClient } from "@supabase/supabase-js";

const url = "https://erguqrisqtugfysofwdd.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";
const sb = createClient(url, key);

const inb = await sb.from("inbound_emails").select("id, in_reply_to, thread_id, from, to, subject, created_at").order("created_at", { ascending: true });
console.log(`inbound emails total: ${inb.data.length}`);

let flipped = 0;
let skippedNoOutbound = 0;
let skippedNoLead = 0;
let alreadyReplied = 0;

for (const row of inb.data) {
  // Find outbound thread_id either directly or via in_reply_to
  let threadId = row.thread_id;

  // If thread_id doesn't appear in emails table, use in_reply_to lookup
  if (threadId) {
    const probe = await sb.from("emails").select("id").eq("thread_id", threadId).limit(1);
    if (!probe.data || probe.data.length === 0) threadId = null;
  }
  if (!threadId && row.in_reply_to) {
    const cleaned = row.in_reply_to.replace(/[<>]/g, "");
    const out = await sb.from("emails").select("thread_id").eq("message_id", cleaned).maybeSingle();
    if (out.data?.thread_id) threadId = out.data.thread_id;
  }
  if (!threadId) { skippedNoOutbound++; continue; }

  // Get the outbound recipient
  const outbound = await sb.from("emails").select("to").eq("thread_id", threadId).order("created_at", { ascending: true }).limit(1);
  const rawTo = outbound.data?.[0]?.to;
  if (!rawTo) { skippedNoOutbound++; continue; }

  // Parse recipient (handles JSON-array and bare-string forms)
  let recipient = rawTo;
  if (recipient.startsWith("[")) {
    try { recipient = JSON.parse(recipient)[0]; } catch {}
  }
  recipient = recipient.split(",")[0].trim().toLowerCase();

  // Find the lead and flip it
  const lead = await sb.from("pipeline_leads")
    .select("id, status")
    .eq("thread_id", threadId)
    .ilike("author_email", recipient)
    .maybeSingle();

  if (!lead.data) {
    // Try without thread_id constraint (older sends might not have thread_id on the lead)
    const lead2 = await sb.from("pipeline_leads")
      .select("id, status")
      .ilike("author_email", recipient)
      .eq("status", "sent")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!lead2.data) { skippedNoLead++; continue; }
    lead.data = lead2.data;
  }

  if (lead.data.status === "replied" || lead.data.status === "wechat_added") {
    alreadyReplied++;
    continue;
  }
  if (lead.data.status !== "sent") { skippedNoLead++; continue; }

  const upd = await sb.from("pipeline_leads")
    .update({ status: "replied" })
    .eq("id", lead.data.id)
    .eq("status", "sent");
  if (upd.error) { console.error(`  fail ${lead.data.id}: ${upd.error.message}`); continue; }
  flipped++;
}

console.log(`\nResults:`);
console.log(`  flipped to replied:    ${flipped}`);
console.log(`  already replied/wechat:${alreadyReplied}`);
console.log(`  skipped (no outbound): ${skippedNoOutbound}`);
console.log(`  skipped (no lead):     ${skippedNoLead}`);

const after = await sb.from("pipeline_leads").select("status", { count: "exact", head: true }).eq("status", "replied");
console.log(`\nFinal pipeline_leads.status='replied' count: ${after.count}`);

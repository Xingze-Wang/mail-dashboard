// Verify: replied_7d on team-overview is the right number?
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const since7d = new Date(Date.now() - 7 * 86400000).toISOString();

// 1) Test exactly what the route does
const { data: routeQ, error: routeErr } = await sb
  .from("email_contact_history")
  .select("rep_id")
  .in("rep_id", [1, 2, 3, 10, 11])
  .gte("received_at", since7d)
  .eq("direction", "inbound");
console.log(`route query result: rows=${routeQ?.length ?? 0}  error=${routeErr?.message ?? "(none)"}`);

// 2) But the route also might rely on PostgREST returning {} when filter columns don't exist.
// Try just one filter at a time.
const { data: r1, error: e1 } = await sb.from("email_contact_history").select("rep_id").in("rep_id", [1, 2, 3, 10, 11]);
console.log(`select rep_id with no other filter: ${e1?.message ?? `rows=${r1?.length ?? 0}`}`);

// 3) Replied 7d alternative: inbound_emails by rep_id + created_at
const { data: inb7d } = await sb
  .from("inbound_emails")
  .select("rep_id, created_at, from, subject")
  .gte("created_at", since7d);
console.log(`\ninbound_emails last 7d: ${inb7d?.length ?? 0}`);
for (const r of inb7d ?? []) console.log(`  rep_id=${r.rep_id}  created=${r.created_at?.slice(0, 19)}  from=${r.from}`);

// 4) 30-day inbound, per rep
const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
const { data: inb30 } = await sb.from("inbound_emails").select("rep_id, created_at").gte("created_at", since30);
const byRep = {};
let nullRep = 0;
for (const r of inb30 ?? []) {
  if (r.rep_id == null) { nullRep++; continue; }
  byRep[r.rep_id] = (byRep[r.rep_id] ?? 0) + 1;
}
console.log(`\ninbound_emails last 30d: total=${inb30?.length ?? 0}  by rep:`, byRep, `null=${nullRep}`);

// 5) Verify webhook_events: did the system ever ingest non-verification events?
const { data: webHist } = await sb.from("webhook_events").select("*").order("created_at", { ascending: false }).limit(20);
console.log(`\nwebhook_events recent rows:`);
for (const w of webHist ?? []) {
  console.log(`  ${w.created_at?.slice(0, 19)}  type=${w.type}  email_id=${w.email_id}`);
}

// 6) Verify the difference: are there many emails where status was updated but no event row?
// emails.status='clicked' but no webhook_events.type='email.clicked'
const { data: clickedEmails } = await sb.from("emails").select("id, status").eq("status", "clicked").limit(5);
console.log(`\nemails status=clicked sample:`);
for (const e of clickedEmails ?? []) {
  const { data: w } = await sb.from("webhook_events").select("type").eq("email_id", e.id);
  console.log(`  id=${e.id.slice(0, 8)}  status=${e.status}  webhook_event types=${(w ?? []).map((x) => x.type).join(",") || "(none)"}`);
}

// 7) "Reply rate" on /pipeline mislabel sanity
console.log(`\n/pipeline 'Reply rate' card shows analytics.channels.conversionRate = wechat / unique_delivered_recipients`);
console.log(`  This is the WeChat conversion rate, NOT a reply rate.`);
console.log(`  No reply count is in /api/pipeline/analytics channels output at all.`);

// 8) "Sent · 7d" mislabel sanity
console.log(`\n/pipeline 'Sent · 7d' card shows analytics.channels.sentLeads, which is`);
console.log(`  pipeline_leads where status in (sent, replied) — ALL TIME, not 7d.`);

// 9) For homepage admin view: totalInbound returns inbound_emails count (24).
// But replied_7d on team-overview returns 0. Discrepancy: did the page mix them?
const { count: inb_total } = await sb.from("inbound_emails").select("*", { count: "exact", head: true });
console.log(`\nhomepage totalInbound = ${inb_total}`);
console.log(`team-overview sum of replied_7d = 0 (route reads non-existent columns).`);

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } }
);

const since90d = new Date(Date.now() - 90*86_400_000).toISOString();

// Replicate segment-funnels query logic exactly
const REACHABLE = new Set(["sent", "delivered", "clicked", "complained", "bounced", "replied"]);
const DELIVERED = new Set(["delivered", "clicked", "complained"]);

const allEmails = [];
let cursor = 0;
const pageSize = 1000;
while (true) {
  const { data, error } = await sb
    .from("emails")
    .select("to, from, status, created_at")
    .order("created_at", { ascending: false })
    .gte("created_at", since90d)
    .range(cursor, cursor + pageSize - 1);
  if (error) { console.error("err", error); break; }
  if (!data || data.length === 0) break;
  allEmails.push(...data);
  if (data.length < pageSize) break;
  cursor += pageSize;
  if (cursor > 100_000) break;
}
console.log("total emails fetched (90d):", allEmails.length);

// Build per-recipient state
const byRecipient = new Map();
for (const e of allEmails) {
  if (!e.to || !e.status) continue;
  if (!REACHABLE.has(e.status)) continue;
  const em = e.to.toLowerCase().trim();
  if (!em.includes("@")) continue;
  const cur = byRecipient.get(em) ?? { delivered: false, clicked: false };
  if (DELIVERED.has(e.status)) cur.delivered = true;
  if (e.status === "clicked") cur.clicked = true;
  byRecipient.set(em, cur);
}
const recipients = [...byRecipient.values()];
console.log("distinct recipients in funnel:", recipients.length);
console.log("delivered (recipient-level):", recipients.filter(r=>r.delivered).length);
console.log("clicked (recipient-level):", recipients.filter(r=>r.clicked).length);

// Now h_index
const { data: leadsRaw } = await sb
  .from("pipeline_leads")
  .select("author_email, h_index");

const featByEmail = new Map();
for (const l of leadsRaw ?? []) {
  const em = (l.author_email ?? "").toLowerCase().trim();
  if (em) featByEmail.set(em, l.h_index);
}
console.log("pipeline_leads with author_email:", featByEmail.size);

// Match
let withFeat = 0, withoutFeat = 0, hIndexBuckets = {"unknown":0,"<5":0,"5-9":0,"10-19":0,"20-49":0,">=50":0,"(no lead data)":0};
for (const [em, st] of byRecipient.entries()) {
  if (!st.delivered) continue;
  const h = featByEmail.has(em) ? featByEmail.get(em) : null;
  if (!featByEmail.has(em)) { withoutFeat++; hIndexBuckets["(no lead data)"]++; continue; }
  withFeat++;
  if (h == null) hIndexBuckets.unknown++;
  else if (h >= 50) hIndexBuckets[">=50"]++;
  else if (h >= 20) hIndexBuckets["20-49"]++;
  else if (h >= 10) hIndexBuckets["10-19"]++;
  else if (h >= 5) hIndexBuckets["5-9"]++;
  else hIndexBuckets["<5"]++;
}
console.log("delivered with lead-feat match:", withFeat);
console.log("delivered with NO lead-feat match (orphans):", withoutFeat);
console.log("h_index buckets (delivered):", hIndexBuckets);

// "(no lead data)" + "unknown" segments — these are usually hidden in the UI cards
const knownN = hIndexBuckets[">=50"] + hIndexBuckets["20-49"] + hIndexBuckets["10-19"] + hIndexBuckets["5-9"] + hIndexBuckets["<5"];
console.log("delivered with KNOWN h_index:", knownN);
console.log("delivered total:", recipients.filter(r=>r.delivered).length);
console.log("\\n→ If UI hides '(no lead data)' / '(unknown)', it shows", knownN, "of", recipients.filter(r=>r.delivered).length, "delivered");

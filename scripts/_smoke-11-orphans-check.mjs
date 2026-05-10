import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } }
);

// Check email_contact_history
const { count } = await sb.from("email_contact_history").select("*", { count: "exact", head: true });
console.log("email_contact_history rows:", count);

const { data: sources } = await sb.from("email_contact_history").select("source").limit(2000);
const c = {};
for (const s of sources ?? []) c[s.source] = (c[s.source]||0)+1;
console.log("by source:", c);

// Get distinct emails in contact history
const allCH = [];
let cur = 0;
while (true) {
  const { data } = await sb.from("email_contact_history").select("email").range(cur, cur+999);
  if (!data || data.length === 0) break;
  allCH.push(...data);
  if (data.length < 1000) break;
  cur += 1000;
}
const chSet = new Set(allCH.map(r => (r.email ?? "").toLowerCase().trim()).filter(Boolean));
console.log("distinct emails in contact_history:", chSet.size);

// Get pipeline_leads emails
const allLeads = [];
cur = 0;
while (true) {
  const { data } = await sb.from("pipeline_leads").select("author_email").range(cur, cur+999);
  if (!data || data.length === 0) break;
  allLeads.push(...data);
  if (data.length < 1000) break;
  cur += 1000;
}
const leadSet = new Set(allLeads.map(r => (r.author_email ?? "").toLowerCase().trim()).filter(Boolean));
console.log("distinct author_email in pipeline_leads:", leadSet.size);

const overlap = [...chSet].filter(e => leadSet.has(e)).length;
console.log("contact_history ∩ pipeline_leads:", overlap);
console.log("in contact_history but NOT in pipeline_leads:", chSet.size - overlap);

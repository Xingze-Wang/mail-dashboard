import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } }
);

// Check yangruoliu1@gmail.com - try all the columns
const probe = "yangruoliu1@gmail.com";
const { data: a } = await sb.from("pipeline_leads").select("id, author_name, author_email, status").or(`author_email.eq.${probe}`);
console.log("by author_email exact:", a?.length, a);

// Try ilike (in case of leading/trailing whitespace)
const { data: b } = await sb.from("pipeline_leads").select("id, author_name, author_email").ilike("author_email", probe);
console.log("by ilike:", b?.length, b);

// Maybe it's in the email_history with a person?
const { data: hist } = await sb.from("email_contact_history").select("*").or(`email.eq.${probe}`);
console.log("contact_history match:", hist?.length, hist?.[0]);

// Maybe stored in person primary_email?
try {
  const { data: pers } = await sb.from("persons").select("id, primary_email, all_emails").eq("primary_email", probe);
  console.log("persons by primary_email:", pers?.length);
} catch(e) { console.log("no persons table?", e.message); }

// Look at all unique author_email in pipeline_leads — maybe trim issues
const allLeads = [];
let c = 0;
while (true) {
  const { data } = await sb.from("pipeline_leads").select("author_email").range(c, c+999);
  if (!data || data.length === 0) break;
  allLeads.push(...data);
  if (data.length < 1000) break;
  c += 1000;
}
const lcEmails = new Set(allLeads.map(l => (l.author_email ?? "").toLowerCase().trim()).filter(Boolean));
console.log("Total distinct author_email in leads:", lcEmails.size);

// Check distinct sends
const since = new Date(Date.now() - 90*86_400_000).toISOString();
const allEmails = [];
let c2 = 0;
while (true) {
  const { data } = await sb.from("emails").select("to").gte("created_at", since).range(c2, c2+999);
  if (!data || data.length === 0) break;
  allEmails.push(...data);
  if (data.length < 1000) break;
  c2 += 1000;
}
const lcSent = new Set(allEmails.map(e => (e.to ?? "").toLowerCase().trim()).filter(Boolean));
console.log("Distinct sent recipients (90d):", lcSent.size);

const overlap = [...lcSent].filter(e => lcEmails.has(e)).length;
console.log("Overlap (sent ∩ leads.author_email):", overlap);
console.log("Sent recipients NOT in leads:", lcSent.size - overlap);

import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } }
);

// Sample some orphan emails
const since = new Date(Date.now() - 90*86_400_000).toISOString();
const { data: emails } = await sb.from("emails").select("to, status").gte("created_at", since).limit(2000);

// Get all author_emails (paginated)
const allLeads = [];
let cursor = 0;
while (true) {
  const { data } = await sb.from("pipeline_leads").select("author_email").range(cursor, cursor+999);
  if (!data || data.length === 0) break;
  allLeads.push(...data);
  if (data.length < 1000) break;
  cursor += 1000;
}
const knownEmails = new Set(allLeads.map(l => (l.author_email ?? "").toLowerCase().trim()).filter(Boolean));

// Show 10 sample orphans
const seen = new Set();
const samples = [];
for (const e of emails ?? []) {
  if (!e.to) continue;
  const t = e.to.toLowerCase().trim();
  if (seen.has(t)) continue;
  seen.add(t);
  if (!knownEmails.has(t)) samples.push(t);
  if (samples.length >= 20) break;
}
console.log("orphan recipients sample:");
for (const s of samples) console.log("  ", s);

// And also check: are these in a co-author table, or a different table?
// Maybe co-authors / paper_authors?
const orphan = samples[0];
console.log("\nlooking for", orphan, "in other tables…");

const { data: coauthors } = await sb.from("paper_authors").select("*").eq("email", orphan).limit(2).maybeSingle().catch(()=>({data:null}));
console.log("paper_authors match:", coauthors);

const { data: persons } = await sb.from("persons").select("*").or(`primary_email.eq.${orphan},all_emails.cs.{${orphan}}`).limit(2);
console.log("persons match:", persons?.length, persons?.[0]);

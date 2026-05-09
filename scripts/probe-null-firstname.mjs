import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
// Distribution of first_name values
const { data: anyNullStr } = await sb
  .from("pipeline_leads")
  .select("id, first_name, author_email, status")
  .eq("first_name", "null")
  .limit(10);
console.log(`Leads with first_name='null' (literal string): ${anyNullStr?.length ?? 0}`);
for (const l of anyNullStr ?? []) console.log(`  ${l.status} ${l.id} ${l.author_email}`);

const { count: nullStrCount } = await sb
  .from("pipeline_leads")
  .select("id", { count: "exact", head: true })
  .eq("first_name", "null");
console.log(`Total leads with first_name='null': ${nullStrCount}`);

const { count: actualNullCount } = await sb
  .from("pipeline_leads")
  .select("id", { count: "exact", head: true })
  .is("first_name", null);
console.log(`Total leads with first_name IS NULL (real): ${actualNullCount}`);

const { count: total } = await sb
  .from("pipeline_leads")
  .select("id", { count: "exact", head: true });
console.log(`Total pipeline_leads: ${total}`);

// Also check the "null" string in draft_html — leads that already have it baked
const { count: draftWithNull } = await sb
  .from("pipeline_leads")
  .select("id", { count: "exact", head: true })
  .ilike("draft_html", "%null好%")
  .not("status", "in", "(sent,skipped,replied)");
console.log(`\nNot-yet-sent drafts containing "null好": ${draftWithNull}`);

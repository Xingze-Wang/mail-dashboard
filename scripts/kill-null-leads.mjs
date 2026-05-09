/**
 * Kill leads with garbage first_name values ("null", "undefined", etc).
 * Per user: "if there is null or anything like that just kill the lead".
 *
 * Hard delete — these are leads we should never have ingested. The
 * scanner's input had a missing-field bug that stringified null/undefined.
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const GARBAGE = ["null", "undefined", "None", "nan", "NaN", "NULL", "Null"];

// Find offenders. Skip already-sent (audit data).
const { data: bad } = await sb
  .from("pipeline_leads")
  .select("id, first_name, author_email, status")
  .in("first_name", GARBAGE)
  .not("status", "in", "(sent)");

console.log(`Found ${bad?.length ?? 0} not-yet-sent leads with garbage first_name:`);
for (const l of bad ?? []) {
  console.log(`  ${l.id} fn="${l.first_name}" email=${l.author_email} status=${l.status}`);
}

if ((bad?.length ?? 0) > 0) {
  const ids = (bad ?? []).map((l) => l.id);
  const { error } = await sb.from("pipeline_leads").delete().in("id", ids);
  if (error) {
    console.error("Delete failed:", error.message);
    process.exit(1);
  }
  console.log(`✓ Deleted ${ids.length} bad leads.`);
}

// Also check sent ones (just report — don't delete audit data)
const { data: sent } = await sb
  .from("pipeline_leads")
  .select("id, first_name, author_email")
  .in("first_name", GARBAGE)
  .eq("status", "sent");
if ((sent?.length ?? 0) > 0) {
  console.log(`\n⚠️  ${sent.length} ALREADY-SENT leads have garbage first_name (left in place for audit):`);
  for (const l of sent) console.log(`  ${l.id} fn="${l.first_name}" email=${l.author_email}`);
}

import { createClient } from "@supabase/supabase-js";

const url = "https://erguqrisqtugfysofwdd.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";

// Supabase REST has no raw-SQL endpoint, so we test column existence by
// trying a select, then bail out asking the user to run the SQL.
const sb = createClient(url, key);
const probe = await sb.from("patterns").select("id").limit(1);
if (probe.error && probe.error.code === "42P01") {
  console.log("MISSING: patterns table does not exist.");
  console.log("Paste migrations/021-patterns.sql into Supabase SQL editor and re-run this script.");
  process.exit(2);
}
if (probe.error) {
  console.log("ERROR probing patterns table:", probe.error.message);
  process.exit(1);
}
console.log(`OK: patterns table exists (${probe.data?.length ?? 0} rows visible).`);

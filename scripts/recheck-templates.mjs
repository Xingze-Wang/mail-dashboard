import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { data, count, error } = await sb
  .from("email_templates")
  .select("*", { count: "exact" });
if (error) { console.error("ERR:", error.message); process.exit(1); }
console.log(`count=${count} returned=${data?.length}`);
for (const r of data ?? []) {
  console.log(`  id=${r.id} name=${r.name} status=${r.status} active=${r.active}`);
}

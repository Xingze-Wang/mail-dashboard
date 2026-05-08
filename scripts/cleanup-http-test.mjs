import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
// Match "TEST_*" or "(HTTP test)*" lark_open_id, plus by id directly.
const { data: prior } = await sb.from("pending_onboarding").select("id, lark_open_id, lark_name").or("lark_open_id.like.TEST%,lark_name.like.(HTTP%");
console.log("Found:", prior);
for (const r of prior ?? []) {
  await sb.from("pending_onboarding").delete().eq("id", r.id);
  console.log("Deleted", r.id);
}

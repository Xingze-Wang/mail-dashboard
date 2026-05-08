import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
// Drop the 3 noop proposals + the matching admin_inbox rows
const { data: deletedTpls } = await sb
  .from("email_templates")
  .delete()
  .eq("status", "proposal")
  .eq("proposed_by", "congress")
  .select("id, name");
console.log(`Deleted ${deletedTpls?.length ?? 0} noop proposal templates:`);
for (const t of deletedTpls ?? []) console.log(`  - ${t.name}`);

const { data: deletedInbox } = await sb
  .from("admin_inbox")
  .delete()
  .ilike("headline", "%Template proposal: switch segment%")
  .select("id, headline");
console.log(`Deleted ${deletedInbox?.length ?? 0} matching admin_inbox idea rows`);
for (const i of deletedInbox ?? []) console.log(`  - ${i.headline?.slice(0, 80)}`);

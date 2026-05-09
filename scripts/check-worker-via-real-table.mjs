import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { data: row } = await sb.from("lark_messages").select("*").limit(1);
if (row?.[0]) console.log("lark_messages columns:", Object.keys(row[0]).join(", "));

const { data: latest } = await sb
  .from("lark_messages")
  .select("*")
  .order("created_at", { ascending: false })
  .limit(5);
for (const m of latest ?? []) {
  console.log(`  ${m.created_at} role=${m.role ?? '?'} sender=${(m.sender_open_id ?? m.from_open_id ?? '').slice(0,16)} body="${(m.text ?? m.body ?? '').slice(0, 60)}"`);
}

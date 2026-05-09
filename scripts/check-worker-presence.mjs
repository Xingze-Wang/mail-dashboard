import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const since1h = new Date(Date.now() - 3600 * 1000).toISOString();
const since6h = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
for (const [label, since] of [["1h", since1h], ["6h", since6h], ["24h", since24h]]) {
  const { count } = await sb
    .from("lark_messages")
    .select("id", { count: "exact", head: true })
    .gte("received_at", since);
  console.log(`lark_messages in last ${label}: ${count}`);
}
const { data: latest } = await sb
  .from("lark_messages")
  .select("received_at, role, sender_open_id, body")
  .order("received_at", { ascending: false })
  .limit(3);
console.log("\nLatest 3:");
for (const m of latest ?? []) {
  console.log(`  ${m.received_at?.slice(0,19)} role=${m.role} sender=${m.sender_open_id?.slice(0,16)}... body="${(m.body ?? '').slice(0, 60)}"`);
}

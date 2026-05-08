import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { data, error } = await sb
  .from("email_templates")
  .select("id, name, rep_id, active, notes, created_at")
  .order("created_at", { ascending: false });
if (error) { console.error("ERR:", error.message); process.exit(1); }
console.log(`${data.length} rows in email_templates:`);
for (const r of data) {
  console.log(`  ${r.active ? '✓' : '✗'} ${r.name.padEnd(30)} rep_id=${r.rep_id ?? '(global)'}  ${r.notes ?? ''}`);
}

// Bonus: count of overrides
const { data: ov } = await sb
  .from("email_template_overrides")
  .select("template_id, slot_name, when");
console.log(`\n${ov?.length ?? 0} rows in email_template_overrides`);
for (const o of ov ?? []) {
  console.log(`  ${o.slot_name} when=${JSON.stringify(o.when)}`);
}

// And: how many leads have template_id stamped vs null
const { count: total } = await sb.from("emails").select("id", { count: "exact", head: true });
const { count: withTpl } = await sb.from("emails").select("id", { count: "exact", head: true }).not("template_id", "is", null);
console.log(`\nemails: ${withTpl}/${total} have template_id stamped`);

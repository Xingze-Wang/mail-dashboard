/**
 * Full state check for Ethan (rep_id=3, 曹鸿宇泽). User says "many
 * things aren't working" — list everything that's missing/broken so
 * we know what to fix.
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

console.log("=== Ethan rep row (rep_id=3) ===");
const { data: rep } = await sb
  .from("sales_reps")
  .select("*")
  .eq("id", 3)
  .maybeSingle();
console.log(JSON.stringify(rep, null, 2));

console.log("\n=== Lead assignment to Ethan ===");
const { data: leads, count } = await sb
  .from("pipeline_leads")
  .select("id, status, created_at", { count: "exact", head: false })
  .eq("assigned_rep_id", 3)
  .order("created_at", { ascending: false })
  .limit(5);
console.log(`Total leads assigned to Ethan: ${count}`);
console.log("Last 5:");
for (const l of leads ?? []) console.log(`  ${l.created_at?.slice(0,16)} ${l.status} ${l.id}`);

console.log("\n=== Emails sent BY Ethan (actor_rep_id=3) ===");
const { count: sentByEthan } = await sb
  .from("emails")
  .select("id", { count: "exact", head: true })
  .eq("actor_rep_id", 3);
console.log(`Total emails actor=ethan: ${sentByEthan}`);

console.log("\n=== Emails OWNED by Ethan (rep_id=3) ===");
const { count: ownedByEthan } = await sb
  .from("emails")
  .select("id", { count: "exact", head: true })
  .eq("rep_id", 3);
console.log(`Total emails rep_id=ethan: ${ownedByEthan}`);

console.log("\n=== Onboarding stamps ===");
console.log(`onboarded_at: ${rep?.onboarded_at}`);
console.log(`trust_level: ${rep?.trust_level ?? "(not set)"}`);
console.log(`trust_notes: ${rep?.trust_notes ?? "(none)"}`);
console.log(`followup_d1_sent_at: ${rep?.followup_d1_sent_at ?? "(not yet)"}`);
console.log(`followup_d7_sent_at: ${rep?.followup_d7_sent_at ?? "(not yet)"}`);

console.log("\n=== Per-rep template ===");
const { data: tpl } = await sb
  .from("email_templates")
  .select("id, name, status, segment_default")
  .eq("rep_id", 3)
  .maybeSingle();
console.log(`Per-rep template: ${tpl ? `${tpl.name} (${tpl.status})` : "(none — uses global)"}`);

console.log("\n=== Assignment routing — does any rule send leads to Ethan? ===");
const { data: cfg } = await sb
  .from("system_config")
  .select("key, value")
  .like("key", "assignment%");
for (const r of cfg ?? []) {
  console.log(`  ${r.key}: ${typeof r.value === "object" ? JSON.stringify(r.value).slice(0, 200) : r.value}`);
}

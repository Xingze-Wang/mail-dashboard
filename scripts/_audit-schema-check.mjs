// Check actual column schemas via PostgREST OPTIONS / sample rows.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

for (const tbl of ["email_contact_history", "brief_lookups", "inbound_emails", "v_mission_today", "missions", "daily_rep_brief", "emails", "pipeline_leads"]) {
  const { data, error } = await sb.from(tbl).select("*").limit(1);
  if (error) {
    console.log(`${tbl}: ERROR ${error.message}`);
    continue;
  }
  if (!data || data.length === 0) {
    console.log(`${tbl}: empty table — schema unknown via sample. Try count.`);
    const { count } = await sb.from(tbl).select("*", { count: "exact", head: true });
    console.log(`  row count: ${count}`);
    continue;
  }
  console.log(`${tbl}: cols = ${Object.keys(data[0]).join(", ")}`);
}

// Explicit check: does email_contact_history have direction/rep_id/received_at?
const { error: errD } = await sb.from("email_contact_history").select("direction").limit(1);
console.log(`\nemail_contact_history.direction exists?  ${errD ? "NO — " + errD.message : "yes"}`);
const { error: errR } = await sb.from("email_contact_history").select("rep_id").limit(1);
console.log(`email_contact_history.rep_id exists?     ${errR ? "NO — " + errR.message : "yes"}`);
const { error: errRcv } = await sb.from("email_contact_history").select("received_at").limit(1);
console.log(`email_contact_history.received_at exists? ${errRcv ? "NO — " + errRcv.message : "yes"}`);

// brief_lookups.wechat_at
const { error: errW } = await sb.from("brief_lookups").select("wechat_at").limit(1);
console.log(`brief_lookups.wechat_at exists? ${errW ? "NO — " + errW.message : "yes"}`);

// Daily brief
const { count: briefCount } = await sb.from("daily_rep_brief").select("*", { count: "exact", head: true });
console.log(`\ndaily_rep_brief rows: ${briefCount}`);
const today = new Date().toISOString().slice(0, 10);
const { count: briefToday } = await sb.from("daily_rep_brief").select("*", { count: "exact", head: true }).eq("brief_date", today);
console.log(`daily_rep_brief for ${today}: ${briefToday}`);

// missions table
const { count: missionsAll } = await sb.from("missions").select("*", { count: "exact", head: true });
console.log(`\nmissions table rows: ${missionsAll}`);
const { count: missionsToday } = await sb.from("missions").select("*", { count: "exact", head: true }).eq("due_date", today);
console.log(`missions for due_date=${today}: ${missionsToday}`);
const { data: missionsRecent } = await sb.from("missions").select("id, rep_id, kind, target, due_date, status, progress_count").order("due_date", { ascending: false }).limit(8);
console.log(`recent missions:`);
for (const m of missionsRecent ?? []) console.log(`  ${m.due_date} rep=${m.rep_id} kind=${m.kind} target=${m.target} progress_count=${m.progress_count} status=${m.status}`);

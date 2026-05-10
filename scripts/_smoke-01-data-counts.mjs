import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } }
);

const since90d = new Date(Date.now() - 90*86_400_000).toISOString();

// 1. Total emails count (90d)
const { count: emailsCount } = await sb.from("emails").select("*", { count: "exact", head: true }).gte("created_at", since90d);
console.log("emails (last 90d, all rows):", emailsCount);

// 2. Distinct recipients (90d)
const { data: tos } = await sb.from("emails").select("to").gte("created_at", since90d);
const uniqueTos = new Set((tos ?? []).map(r => (r.to ?? "").toLowerCase().trim()).filter(Boolean));
console.log("distinct recipients in emails (90d):", uniqueTos.size);

// 3. By status
const { data: statuses } = await sb.from("emails").select("status").gte("created_at", since90d);
const statusCounts = {};
for (const s of statuses ?? []) statusCounts[s.status ?? "(null)"] = (statusCounts[s.status ?? "(null)"] ?? 0) + 1;
console.log("status breakdown (90d):", statusCounts);

// 4. pipeline_leads
const { count: leadsCount } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true });
console.log("total pipeline_leads:", leadsCount);

// 5. leads with h_index
const { count: leadsWithH } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).not("h_index", "is", null);
console.log("pipeline_leads with h_index:", leadsWithH);

// 6. pipeline_leads.status distribution
const { data: pls } = await sb.from("pipeline_leads").select("status");
const pcounts = {};
for (const s of pls ?? []) pcounts[s.status ?? "(null)"] = (pcounts[s.status ?? "(null)"] ?? 0) + 1;
console.log("pipeline_leads.status:", pcounts);

// 7. brief_lookups conversions (90d)
const { count: bcount } = await sb.from("brief_lookups").select("*", { count: "exact", head: true }).eq("added_wechat", true).gte("created_at", since90d);
console.log("brief_lookups added_wechat=true (90d):", bcount);

// 8. webhook_events recent
const { count: wcount } = await sb.from("webhook_events").select("*", { count: "exact", head: true }).gte("created_at", since90d);
console.log("webhook_events (90d):", wcount);


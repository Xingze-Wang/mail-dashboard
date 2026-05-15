// Drill into Leo and Yujie attribution discrepancies.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Yujie's sender_email
const { data: yujie } = await sb.from("sales_reps").select("*").eq("id", 2).single();
console.log("Yujie sender_email:", yujie.sender_email);
console.log("Yujie name:", yujie.name);

// All emails from Yujie's sender_email
async function drainAll(makeQ) {
  const all = [];
  let from = 0;
  const batch = 1000;
  while (true) {
    const { data, error } = await makeQ().range(from, from + batch - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < batch) break;
    from += batch;
    if (from > 100_000) break;
  }
  return all;
}

const yujieEmails = await drainAll(() =>
  sb.from("emails").select("id, from, status, created_at, actor_rep_id, rep_id").ilike("from", `%${yujie.sender_email}%`),
);
console.log(`\nemails ilike '%${yujie.sender_email}%': ${yujieEmails.length}`);

// Distinct from values
const fromHist = {};
for (const e of yujieEmails) fromHist[e.from] = (fromHist[e.from] ?? 0) + 1;
console.log("from values:", Object.entries(fromHist).slice(0, 5));

const yujieByActor = await drainAll(() =>
  sb.from("emails").select("id, from, status, created_at, actor_rep_id").eq("actor_rep_id", 2),
);
console.log(`\nemails actor_rep_id=2: ${yujieByActor.length}`);
const fromHistActor = {};
for (const e of yujieByActor) fromHistActor[e.from] = (fromHistActor[e.from] ?? 0) + 1;
console.log("from values:", Object.entries(fromHistActor).slice(0, 5));

// Why discrepancy? maybe Yujie has 261 rows under actor_rep_id=2 but with a different `from` (e.g. her name only, not her email).
const byActorNotByFrom = yujieByActor.filter((e) => !(e.from ?? "").toLowerCase().includes(yujie.sender_email.toLowerCase()));
console.log(`emails actor_rep_id=2 but from NOT containing sender_email: ${byActorNotByFrom.length}`);
if (byActorNotByFrom.length > 0) {
  const distinct = {};
  for (const e of byActorNotByFrom) distinct[e.from] = (distinct[e.from] ?? 0) + 1;
  console.log("their `from` values:", Object.entries(distinct).slice(0, 5));
}

// Leo: huge gap between ready_queue=180 and assigned=220, but only 27 sent_pipeline despite 1141 actor_rep_id rows
console.log("\n--- Leo ---");
const { data: leo } = await sb.from("sales_reps").select("*").eq("id", 1).single();
console.log("Leo sender_email:", leo.sender_email);
// Leo's pipeline_leads
const { count: leoAssigned } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", 1);
const { count: leoSent } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", 1).in("status", ["sent", "replied"]);
const { count: leoEmailsActor } = await sb.from("emails").select("*", { count: "exact", head: true }).eq("actor_rep_id", 1);
const { count: leoEmailsFrom } = await sb.from("emails").select("*", { count: "exact", head: true }).ilike("from", `%${leo.sender_email}%`);
console.log(`Leo pipeline_leads.assigned=${leoAssigned}  sent=${leoSent}`);
console.log(`Leo emails.actor_rep_id=1: ${leoEmailsActor}`);
console.log(`Leo emails.from ilike: ${leoEmailsFrom}`);

// /api/metrics/me for Leo specifically — leadRate uses resendSent as denominator
// 1141 emails. If Leo has 0 wechat marked_by_rep_id=1, his leadRate = 0/1141 = 0%
// But many of his "1141 emails" are actually historical sends from Yujie/old senders that
// got attributed to Leo (id=1) under the legacy comment in the route. Let's verify.
const { data: leoOldEmails } = await sb.from("emails").select("from, created_at").eq("actor_rep_id", 1).order("created_at", { ascending: true }).limit(5);
console.log("\nLeo's earliest emails (actor_rep_id=1):");
for (const e of leoOldEmails ?? []) console.log(`  ${e.created_at}  ${e.from}`);
const { data: leoNewEmails } = await sb.from("emails").select("from, created_at").eq("actor_rep_id", 1).order("created_at", { ascending: false }).limit(5);
console.log("Leo's latest emails (actor_rep_id=1):");
for (const e of leoNewEmails ?? []) console.log(`  ${e.created_at}  ${e.from}`);

// "Sent · 7d" on /pipeline analytics uses pipeline_leads sent status, not actor_rep_id
// But user said "/pipeline" stat strip. Let me look at the actual stats.
console.log("\n--- /pipeline strip via analytics, admin view ---");
const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
const { count: weekLeads } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).gte("created_at", sevenDaysAgo);
const { count: readyTotal } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("status", "ready");
console.log(`leads in last 7 days: ${weekLeads}`);
console.log(`status=ready total: ${readyTotal}`);

// pipeline_leads sent_at vs status
console.log("\n--- pipeline_leads attribution drift ---");
const { count: sentStatusNoActor } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).in("status", ["sent", "replied"]).is("assigned_rep_id", null);
console.log(`pipeline_leads sent/replied with assigned_rep_id NULL: ${sentStatusNoActor}`);

// How many emails were sent today vs yesterday with each actor_rep_id?
console.log("\n--- emails today ---");
const todayBjStart = new Date(Math.floor((Date.now() + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000).toISOString();
const { data: todayEmails } = await sb.from("emails").select("actor_rep_id, status, from").gte("created_at", todayBjStart);
console.log(`emails since Beijing-today start: ${todayEmails?.length ?? 0}`);
const byActor = {};
for (const e of todayEmails ?? []) {
  const k = `${e.actor_rep_id ?? "null"}/${e.status}`;
  byActor[k] = (byActor[k] ?? 0) + 1;
}
console.log("by actor_rep_id/status:", byActor);

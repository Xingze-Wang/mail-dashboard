// Audit: does what /api/metrics, /api/metrics/me, /api/missions, /api/admin/team-overview,
// /api/pipeline/analytics return match what's actually in the DB?
//
// Each section pulls the route's input tables, runs the route's logic
// against them, then runs the strict alternative (e.g. webhook_events vs
// emails.status) and prints both side by side.
//
// Run: npx tsx scripts/_audit-numbers.mjs
//   or: node scripts/_audit-numbers.mjs

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://erguqrisqtugfysofwdd.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

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

function line() { console.log("─".repeat(80)); }
function section(t) { console.log(`\n\n###### ${t} ######\n`); }

// ────────────────────────────────────────────────────────────────────────
section("0. baseline table sizes");
// ────────────────────────────────────────────────────────────────────────
for (const tbl of ["emails", "webhook_events", "pipeline_leads", "brief_lookups", "email_contact_history", "inbound_emails", "sales_reps"]) {
  const { count, error } = await sb.from(tbl).select("*", { count: "exact", head: true });
  console.log(`${tbl.padEnd(28)}: ${error ? "ERROR " + error.message : count + " rows"}`);
}

// Sales reps roster (so we can spot-check by name)
const { data: reps } = await sb.from("sales_reps").select("id, name, sender_name, sender_email, role, active").order("id");
console.log("\nreps roster:");
for (const r of reps ?? []) {
  console.log(`  ${String(r.id).padStart(2)} ${r.role.padEnd(7)} ${r.name?.padEnd(14)} ${r.sender_email ?? "(no sender)"}`);
}

// ────────────────────────────────────────────────────────────────────────
section("A. /api/metrics — homepage stat cards (admin view, org-wide)");
// ────────────────────────────────────────────────────────────────────────
// Replicates getDbFunnel({}) (admin: fromContains=null)

const emailsAll = await drainAll(() =>
  sb.from("emails").select("id, status, created_at, to, from").order("created_at", { ascending: false }),
);
console.log(`fetched ${emailsAll.length} email rows`);

// Same logic db-funnel.ts uses
const DELIVERED_SET = new Set(["delivered", "clicked", "complained"]);

// Pull email_history (view backed by webhook_events)
const ids = emailsAll.map((e) => e.id).filter(Boolean);
const clickedIds = new Set();
const bouncedIds = new Set();
for (let i = 0; i < ids.length; i += 150) {
  const chunk = ids.slice(i, i + 150);
  const { data } = await sb.from("email_history").select("email_id, was_clicked, was_bounced").in("email_id", chunk);
  for (const r of data ?? []) {
    if (r.was_clicked) clickedIds.add(r.email_id);
    if (r.was_bounced) bouncedIds.add(r.email_id);
  }
}

let totalSent = 0, totalDelivered = 0, totalClicked = 0, totalBounced = 0, totalComplained = 0;
let totalClicked_statusOnly = 0, totalBounced_statusOnly = 0;
for (const e of emailsAll) {
  const status = (e.status ?? "sent").toLowerCase();
  const clicked = e.id ? clickedIds.has(e.id) : status === "clicked";
  const bounced = e.id ? bouncedIds.has(e.id) : status === "bounced";
  if (status !== "queued") totalSent++;
  if (DELIVERED_SET.has(status)) totalDelivered++;
  if (clicked) totalClicked++;
  if (bounced) totalBounced++;
  if (status === "complained") totalComplained++;
  if (status === "clicked") totalClicked_statusOnly++;
  if (status === "bounced") totalBounced_statusOnly++;
}

console.log(`\nAPI returns (replicating getDbFunnel):`);
console.log(`  totalSent       = ${totalSent}`);
console.log(`  totalDelivered  = ${totalDelivered}`);
console.log(`  totalClicked    = ${totalClicked}    (via email_history view, fallback to status)`);
console.log(`  totalBounced    = ${totalBounced}    (via email_history view, fallback to status)`);
console.log(`  totalComplained = ${totalComplained}`);
console.log(`  deliveryRate    = ${totalSent > 0 ? ((totalDelivered / totalSent) * 100).toFixed(1) : 0}%`);
console.log(`  clickRate       = ${totalDelivered > 0 ? ((totalClicked / totalDelivered) * 100).toFixed(1) : 0}%`);

// Ground truth via webhook_events (canonical append-only log)
const events = await drainAll(() => sb.from("webhook_events").select("email_id, type"));
const eventsByEmail = new Map();
for (const ev of events) {
  if (!ev.email_id) continue;
  const set = eventsByEmail.get(ev.email_id) ?? new Set();
  set.add(ev.type);
  eventsByEmail.set(ev.email_id, set);
}
console.log(`\nwebhook_events: ${events.length} rows, distinct email_ids=${eventsByEmail.size}`);
const evTypes = {};
for (const ev of events) evTypes[ev.type] = (evTypes[ev.type] ?? 0) + 1;
console.log(`  events by type:`, evTypes);

let groundClicked = 0, groundBounced = 0, groundDelivered = 0, groundOpened = 0, groundComplained = 0;
for (const [, types] of eventsByEmail) {
  if (types.has("email.clicked") || types.has("clicked")) groundClicked++;
  if (types.has("email.bounced") || types.has("bounced")) groundBounced++;
  if (types.has("email.delivered") || types.has("delivered")) groundDelivered++;
  if (types.has("email.opened") || types.has("opened")) groundOpened++;
  if (types.has("email.complained") || types.has("complained")) groundComplained++;
}
console.log(`\nGround truth (from webhook_events, "ever happened"):`);
console.log(`  ever delivered  = ${groundDelivered}`);
console.log(`  ever opened     = ${groundOpened}`);
console.log(`  ever clicked    = ${groundClicked}`);
console.log(`  ever bounced    = ${groundBounced}`);
console.log(`  ever complained = ${groundComplained}`);
console.log(`\nemails.status histogram (latest-event-wins, lossy):`);
const statusHist = {};
for (const e of emailsAll) statusHist[e.status ?? "(null)"] = (statusHist[e.status ?? "(null)"] ?? 0) + 1;
console.log(` `, statusHist);
console.log(`\nDelta:`);
console.log(`  clicked: API=${totalClicked}  vs ground=${groundClicked}  diff=${groundClicked - totalClicked}`);
console.log(`  bounced: API=${totalBounced}  vs ground=${groundBounced}  diff=${groundBounced - totalBounced}`);

// ────────────────────────────────────────────────────────────────────────
section("A.2 totalInbound on homepage");
// ────────────────────────────────────────────────────────────────────────
const { count: inboundCount } = await sb.from("inbound_emails").select("*", { count: "exact", head: true });
const { count: ech_inbound } = await sb.from("email_contact_history").select("*", { count: "exact", head: true }).eq("direction", "inbound");
console.log(`inbound_emails table total           = ${inboundCount}`);
console.log(`email_contact_history direction=in   = ${ech_inbound}`);
console.log(`(API returns inbound_emails count, but team-overview replied_7d uses email_contact_history)`);

// ────────────────────────────────────────────────────────────────────────
section("A.3 wechat total (admin)");
// ────────────────────────────────────────────────────────────────────────
const { count: wcAll } = await sb.from("brief_lookups").select("*", { count: "exact", head: true }).eq("added_wechat", true);
const { data: wcRows } = await sb.from("brief_lookups").select("id, lead_id, marked_by_rep_id").eq("added_wechat", true);
const wcDistinctLeads = new Set((wcRows ?? []).map((r) => r.lead_id).filter(Boolean)).size;
const wcWithRep = (wcRows ?? []).filter((r) => r.marked_by_rep_id != null).length;
const wcWithoutRep = (wcRows ?? []).filter((r) => r.marked_by_rep_id == null).length;
console.log(`brief_lookups added_wechat=true: count=${wcAll}, rows=${(wcRows ?? []).length}`);
console.log(`  distinct lead_id     = ${wcDistinctLeads}`);
console.log(`  with marked_by_rep_id = ${wcWithRep}`);
console.log(`  legacy (no actor)    = ${wcWithoutRep}  <- excluded from per-rep, included in admin total`);

// ────────────────────────────────────────────────────────────────────────
section("B. /api/admin/team-overview — per-rep cards (7d)");
// ────────────────────────────────────────────────────────────────────────
const since7d = new Date(Date.now() - 7 * 86400000).toISOString();
const todayDate = new Date().toISOString().slice(0, 10);
const todayStart = todayDate + "T00:00:00";

const repIds = (reps ?? []).filter((r) => r.active && (r.role === "sales" || r.role === "senior")).map((r) => r.id);
console.log(`active sales/senior rep ids: ${repIds.join(", ")}`);

// emails for 7d (replicate route logic) — uses actor_rep_id
const { data: emails7d } = await sb
  .from("emails")
  .select("actor_rep_id, status, created_at")
  .in("actor_rep_id", repIds)
  .gte("created_at", since7d);

console.log(`\nemails(actor_rep_id in reps, 7d): ${emails7d?.length ?? 0} rows`);

// Replicate the route's accumulator
const sentByRep_api = new Map();
for (const e of emails7d ?? []) {
  if (["sent", "delivered", "opened", "clicked"].includes(String(e.status))) {
    sentByRep_api.set(e.actor_rep_id, (sentByRep_api.get(e.actor_rep_id) ?? 0) + 1);
  }
}

// Alternative — count all emails (any reachable status, not just 4 listed)
// The route filter EXCLUDES "bounced" and "complained" (correctly) but
// also EXCLUDES "replied" — which means a sent email that later got a
// reply (status flipped to "replied") drops from the rep's sent count.
const sentByRep_inclusive = new Map();
for (const e of emails7d ?? []) {
  const s = String(e.status);
  if (["sent", "delivered", "opened", "clicked", "replied"].includes(s)) {
    sentByRep_inclusive.set(e.actor_rep_id, (sentByRep_inclusive.get(e.actor_rep_id) ?? 0) + 1);
  }
}

console.log(`\nPer-rep sent_7d:`);
console.log(`  rep_id  api(4 statuses)  inclusive(+replied)  diff`);
for (const r of reps ?? []) {
  if (!repIds.includes(r.id)) continue;
  const a = sentByRep_api.get(r.id) ?? 0;
  const b = sentByRep_inclusive.get(r.id) ?? 0;
  console.log(`  ${String(r.id).padStart(2)} ${r.name?.padEnd(12)}  ${String(a).padStart(7)}  ${String(b).padStart(7)}  ${String(b - a).padStart(5)}`);
}

// Check: emails with actor_rep_id NULL but a sender_email matches a rep
const { data: emailsOrphan } = await sb
  .from("emails")
  .select("id, from, status, actor_rep_id, created_at")
  .is("actor_rep_id", null)
  .gte("created_at", since7d)
  .in("status", ["sent", "delivered", "opened", "clicked"]);
console.log(`\nemails actor_rep_id IS NULL in 7d (sent statuses): ${emailsOrphan?.length ?? 0}`);
if (emailsOrphan && emailsOrphan.length > 0) {
  // Bucket by `from` substring
  const senderHist = {};
  for (const e of emailsOrphan) {
    const f = (e.from || "").toLowerCase();
    senderHist[f] = (senderHist[f] ?? 0) + 1;
  }
  console.log("  by 'from':", senderHist);
}

// replied_7d via email_contact_history.rep_id (route impl)
const { data: ech7d } = await sb
  .from("email_contact_history")
  .select("rep_id, direction")
  .in("rep_id", repIds)
  .gte("received_at", since7d)
  .eq("direction", "inbound");
const repliedByRep_api = new Map();
for (const r of ech7d ?? []) repliedByRep_api.set(r.rep_id, (repliedByRep_api.get(r.rep_id) ?? 0) + 1);
console.log(`\nemail_contact_history rep_id in reps, direction=inbound, 7d: ${ech7d?.length ?? 0} rows`);

// Alternative: inbound_emails (the table used by homepage)
const { data: inb7d } = await sb
  .from("inbound_emails")
  .select("rep_id, created_at")
  .gte("created_at", since7d);
const repliedByRep_alt = new Map();
let inbOrphan = 0;
for (const r of inb7d ?? []) {
  if (r.rep_id == null) { inbOrphan++; continue; }
  repliedByRep_alt.set(r.rep_id, (repliedByRep_alt.get(r.rep_id) ?? 0) + 1);
}
console.log(`inbound_emails 7d: ${inb7d?.length ?? 0} rows (orphan rep_id=${inbOrphan})`);

console.log(`\nPer-rep replied_7d:`);
console.log(`  rep_id  api(ech)  alt(inbound_emails)`);
for (const r of reps ?? []) {
  if (!repIds.includes(r.id)) continue;
  const a = repliedByRep_api.get(r.id) ?? 0;
  const b = repliedByRep_alt.get(r.id) ?? 0;
  console.log(`  ${String(r.id).padStart(2)} ${r.name?.padEnd(12)}  ${String(a).padStart(4)}  ${String(b).padStart(6)}`);
}

// wechat_7d — uses brief_lookups.wechat_at column
const { data: wc7d } = await sb
  .from("brief_lookups")
  .select("marked_by_rep_id, wechat_at, created_at, added_wechat")
  .in("marked_by_rep_id", repIds)
  .eq("added_wechat", true)
  .gte("wechat_at", since7d);
console.log(`\nbrief_lookups added_wechat in 7d, marked_by_rep_id in reps, wechat_at>=since: ${wc7d?.length ?? 0}`);

// Alt: gte("created_at", since7d)
const { data: wc7d_alt } = await sb
  .from("brief_lookups")
  .select("marked_by_rep_id, wechat_at, created_at")
  .in("marked_by_rep_id", repIds)
  .eq("added_wechat", true)
  .gte("created_at", since7d);
console.log(`Alt (gte created_at instead): ${wc7d_alt?.length ?? 0}`);

// How many of the 7d wechat rows have wechat_at IS NULL?
const { data: wcNullCheck } = await sb
  .from("brief_lookups")
  .select("id, marked_by_rep_id, wechat_at, created_at")
  .eq("added_wechat", true)
  .is("wechat_at", null);
console.log(`brief_lookups added_wechat=true with wechat_at NULL: ${wcNullCheck?.length ?? 0}`);

const wcByRep = new Map();
for (const r of wc7d ?? []) wcByRep.set(r.marked_by_rep_id, (wcByRep.get(r.marked_by_rep_id) ?? 0) + 1);
console.log(`\nPer-rep wechat_7d:`);
for (const r of reps ?? []) {
  if (!repIds.includes(r.id)) continue;
  console.log(`  ${String(r.id).padStart(2)} ${r.name?.padEnd(12)}  ${wcByRep.get(r.id) ?? 0}`);
}

// ready_queue — same as homepage
const { data: readyAll } = await sb
  .from("pipeline_leads")
  .select("assigned_rep_id, status")
  .in("assigned_rep_id", repIds)
  .eq("status", "ready");
const readyByRep = new Map();
for (const r of readyAll ?? []) readyByRep.set(r.assigned_rep_id, (readyByRep.get(r.assigned_rep_id) ?? 0) + 1);
console.log(`\nPer-rep ready_queue:`);
for (const r of reps ?? []) {
  if (!repIds.includes(r.id)) continue;
  console.log(`  ${String(r.id).padStart(2)} ${r.name?.padEnd(12)}  ${readyByRep.get(r.id) ?? 0}`);
}

// Spot-check unassigned ready leads
const { count: readyUnassigned } = await sb
  .from("pipeline_leads")
  .select("*", { count: "exact", head: true })
  .is("assigned_rep_id", null)
  .eq("status", "ready");
console.log(`pipeline_leads status=ready assigned_rep_id IS NULL: ${readyUnassigned}`);

// ────────────────────────────────────────────────────────────────────────
section("C. /api/metrics/me — per-rep homepage card");
// ────────────────────────────────────────────────────────────────────────
// Replicates the per-rep API for each active rep.
const CONTACTED = ["sent", "replied"];
for (const r of reps ?? []) {
  if (!repIds.includes(r.id)) continue;
  const { count: assigned } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", r.id);
  const { count: ready } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", r.id).eq("status", "ready");
  const { count: sent_pipeline } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", r.id).in("status", CONTACTED);
  // wechat
  const { data: wcMine } = await sb.from("brief_lookups").select("lead_id").eq("added_wechat", true).eq("marked_by_rep_id", r.id).not("lead_id", "is", null);
  const wcDistinct = new Set((wcMine ?? []).map((x) => x.lead_id)).size;
  // resendSent = total emails from this rep's sender_email
  let resendSent = 0;
  if (r.sender_email) {
    const allRepEmails = await drainAll(() =>
      sb.from("emails").select("id, status, from").ilike("from", `%${r.sender_email}%`),
    );
    for (const e of allRepEmails) {
      const s = (e.status ?? "sent").toLowerCase();
      if (s !== "queued") resendSent++;
    }
  }
  const denominator = resendSent > 0 ? resendSent : (sent_pipeline ?? 0);
  const leadRate = denominator > 0 ? ((wcDistinct / denominator) * 100).toFixed(1) : "0.0";
  console.log(`  ${r.name?.padEnd(12)}  assigned=${assigned}  ready=${ready}  sent(pipeline)=${sent_pipeline}  resendSent=${resendSent}  wechat=${wcDistinct}  leadRate=${leadRate}%`);
}

// ────────────────────────────────────────────────────────────────────────
section("D. /api/pipeline/analytics — pipeline stat strip");
// ────────────────────────────────────────────────────────────────────────
const allLeads = await drainAll(() =>
  sb.from("pipeline_leads").select("id, status, lead_tier, assigned_rep_id, created_at, sent_at, author_email"),
);
console.log(`pipeline_leads total: ${allLeads.length}`);

// Status histogram
const statusBuckets = {};
const tierBuckets = {};
for (const l of allLeads) {
  statusBuckets[l.status ?? "(null)"] = (statusBuckets[l.status ?? "(null)"] ?? 0) + 1;
  tierBuckets[l.lead_tier ?? "(null)"] = (tierBuckets[l.lead_tier ?? "(null)"] ?? 0) + 1;
}
console.log("status:", statusBuckets);
console.log("tier:  ", tierBuckets);

// "This week" anchored on Beijing day boundary
function beijingDaysAgoStartUtc(n) {
  const nowUtcMs = Date.now();
  const nowBjMs = nowUtcMs + 8 * 3600_000;
  const bjDayStart = Math.floor(nowBjMs / 86400_000) * 86400_000;
  return new Date(bjDayStart - n * 86400_000 - 8 * 3600_000);
}
const oneWeekAgo = beijingDaysAgoStartUtc(7).toISOString();
const leadsThisWeek = allLeads.filter((l) => l.created_at >= oneWeekAgo).length;
console.log(`leadsThisWeek (>= ${oneWeekAgo.slice(0, 10)}): ${leadsThisWeek}`);
console.log(`ready count: ${statusBuckets["ready"] ?? 0}`);
console.log(`sent (CONTACTED): ${(statusBuckets["sent"] ?? 0) + (statusBuckets["replied"] ?? 0)}`);

// Pipeline analytics "sent" is computed differently (via emails-table delivered set)
// Replicate fetchDeliveredRecipients
const REACHABLE = new Set(["delivered", "clicked", "sent", "replied"]);
const deliveredEmails = new Set();
for (const e of emailsAll) {
  if (REACHABLE.has((e.status ?? "").toLowerCase())) {
    const em = (e.to ?? "").toLowerCase().trim();
    if (em) deliveredEmails.add(em);
  }
}
console.log(`fetchDeliveredRecipients (unique recipients ever reached): ${deliveredEmails.size}`);

// wechat count, unscoped admin view
const { data: wcAdmin } = await sb.from("brief_lookups").select("query").eq("added_wechat", true);
const wcCount = wcAdmin?.length ?? 0;
const conversionRate = deliveredEmails.size > 0 ? ((wcCount / deliveredEmails.size) * 100).toFixed(1) : 0;
console.log(`pipeline conversionRate: wechat=${wcCount} / delivered=${deliveredEmails.size} = ${conversionRate}%`);

// ────────────────────────────────────────────────────────────────────────
section("E. v_mission_today — used by /missions");
// ────────────────────────────────────────────────────────────────────────
const { data: missionsToday, error: mErr } = await sb.from("v_mission_today").select("*");
if (mErr) {
  console.log(`ERROR: ${mErr.message}`);
} else {
  console.log(`v_mission_today: ${missionsToday?.length ?? 0} rows`);
  if (missionsToday && missionsToday.length > 0) {
    console.log("schema (first row):", Object.keys(missionsToday[0]));
    for (const m of missionsToday) {
      console.log(`  rep=${m.rep_id} kind=${m.kind} target=${m.target} progress=${m.progress ?? m.progress_count ?? "?"} status=${m.status ?? "?"}`);
    }
  }
}

// route file used 'progress_count' in MissionRow but team-overview reads 'progress'
const { data: mt2, error: e2 } = await sb.from("v_mission_today").select("progress_count, progress");
if (!e2 && mt2 && mt2.length > 0) {
  const hasProgressCount = mt2.some((r) => r.progress_count != null);
  const hasProgress = mt2.some((r) => r.progress != null);
  console.log(`\nv_mission_today: progress_count populated? ${hasProgressCount}  | progress populated? ${hasProgress}`);
}

// ────────────────────────────────────────────────────────────────────────
section("F. sanity — pipeline_leads.sent_at vs emails.created_at");
// ────────────────────────────────────────────────────────────────────────
// pipeline_leads.sent_at populated for leads sent via pipeline_leads.status=sent
const { count: leadsWithSentAt } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).not("sent_at", "is", null);
const { count: leadsSentStatus } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).in("status", ["sent", "replied"]);
console.log(`pipeline_leads sent_at NOT NULL: ${leadsWithSentAt}`);
console.log(`pipeline_leads status in (sent, replied): ${leadsSentStatus}`);
console.log(`(divergence is fine — sent_at can lag, but big gaps imply attribution drift)`);

// last_activity_at: route only considers emails.created_at, not email_contact_history or inbound_emails
// Check whether any active rep has lastAct from one but not the other.
console.log(`\nlast_activity_at trace for each rep:`);
for (const r of reps ?? []) {
  if (!repIds.includes(r.id)) continue;
  const { data: lastEmail } = await sb.from("emails").select("created_at").eq("actor_rep_id", r.id).order("created_at", { ascending: false }).limit(1);
  const { data: lastEch } = await sb.from("email_contact_history").select("received_at").eq("rep_id", r.id).order("received_at", { ascending: false }).limit(1);
  const ts1 = lastEmail?.[0]?.created_at ?? "(none)";
  const ts2 = lastEch?.[0]?.received_at ?? "(none)";
  console.log(`  ${r.name?.padEnd(12)}  emails.last=${ts1}  ech.last=${ts2}`);
}

console.log("\n\n=== audit complete ===");

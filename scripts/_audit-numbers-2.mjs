// Audit pt 2: continues from C onwards. Retries on transient errors.

import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

async function drainAll(makeQ) {
  const all = [];
  let from = 0;
  const batch = 1000;
  while (true) {
    let data, error;
    for (let retry = 0; retry < 3; retry++) {
      try {
        ({ data, error } = await makeQ().range(from, from + batch - 1));
        break;
      } catch (e) {
        if (retry === 2) throw e;
        await new Promise((r) => setTimeout(r, 500 * (retry + 1)));
      }
    }
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < batch) break;
    from += batch;
    if (from > 100_000) break;
  }
  return all;
}

function section(t) { console.log(`\n\n###### ${t} ######\n`); }

const { data: reps } = await sb.from("sales_reps").select("id, name, sender_name, sender_email, role, active").order("id");
const repIds = (reps ?? []).filter((r) => r.active && (r.role === "sales" || r.role === "senior")).map((r) => r.id);

// ────────────────────────────────────────────────────────────────────────
section("C. /api/metrics/me — per-rep homepage card");
// ────────────────────────────────────────────────────────────────────────
const CONTACTED = ["sent", "replied"];
for (const r of reps ?? []) {
  if (!repIds.includes(r.id)) continue;
  const { count: assigned } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", r.id);
  const { count: ready } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", r.id).eq("status", "ready");
  const { count: sent_pipeline } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("assigned_rep_id", r.id).in("status", CONTACTED);
  const { data: wcMine } = await sb.from("brief_lookups").select("lead_id").eq("added_wechat", true).eq("marked_by_rep_id", r.id).not("lead_id", "is", null);
  const wcDistinct = new Set((wcMine ?? []).map((x) => x.lead_id)).size;
  // resendSent: emails.from ilike %sender_email% (any status except queued)
  let resendSent = 0;
  if (r.sender_email) {
    const allRepEmails = await drainAll(() =>
      sb.from("emails").select("id, status").ilike("from", `%${r.sender_email}%`),
    );
    for (const e of allRepEmails) {
      const s = (e.status ?? "sent").toLowerCase();
      if (s !== "queued") resendSent++;
    }
  }
  // Alternative resendSent: actor_rep_id-based (the new attribution column)
  let resendSent_actor = 0;
  {
    const { count } = await sb.from("emails").select("*", { count: "exact", head: true }).eq("actor_rep_id", r.id).neq("status", "queued");
    resendSent_actor = count ?? 0;
  }
  const denominator = resendSent > 0 ? resendSent : (sent_pipeline ?? 0);
  const leadRate = denominator > 0 ? ((wcDistinct / denominator) * 100).toFixed(1) : "0.0";
  console.log(`  ${r.name?.padEnd(12)}  assigned=${assigned}  ready=${ready}  sent_pipeline=${sent_pipeline}  resendSent(from-ilike)=${resendSent}  resendSent(actor_rep_id)=${resendSent_actor}  wechat=${wcDistinct}  leadRate=${leadRate}%`);
}

// ────────────────────────────────────────────────────────────────────────
section("D. /api/pipeline/analytics — pipeline stat strip");
// ────────────────────────────────────────────────────────────────────────
const allLeads = await drainAll(() =>
  sb.from("pipeline_leads").select("id, status, lead_tier, assigned_rep_id, created_at, sent_at, author_email"),
);
console.log(`pipeline_leads total: ${allLeads.length}`);

const statusBuckets = {};
const tierBuckets = {};
for (const l of allLeads) {
  statusBuckets[l.status ?? "(null)"] = (statusBuckets[l.status ?? "(null)"] ?? 0) + 1;
  tierBuckets[l.lead_tier ?? "(null)"] = (tierBuckets[l.lead_tier ?? "(null)"] ?? 0) + 1;
}
console.log("status histogram:", statusBuckets);
console.log("tier histogram:", tierBuckets);

function beijingDaysAgoStartUtc(n) {
  const nowUtcMs = Date.now();
  const nowBjMs = nowUtcMs + 8 * 3600_000;
  const bjDayStart = Math.floor(nowBjMs / 86400_000) * 86400_000;
  return new Date(bjDayStart - n * 86400_000 - 8 * 3600_000);
}
const oneWeekAgoIso = beijingDaysAgoStartUtc(7).toISOString();
const leadsThisWeek = allLeads.filter((l) => l.created_at >= oneWeekAgoIso).length;
console.log(`"This week" (>=${oneWeekAgoIso.slice(0, 19)}): ${leadsThisWeek}`);
console.log(`ready (status=ready): ${statusBuckets["ready"] ?? 0}`);
console.log(`sent (status in contacted): ${(statusBuckets["sent"] ?? 0) + (statusBuckets["replied"] ?? 0)}`);

const REACHABLE = new Set(["delivered", "clicked", "sent", "replied"]);
const allEmails = await drainAll(() => sb.from("emails").select("id, status, to, from, actor_rep_id"));
const deliveredRecipientsSet = new Set();
for (const e of allEmails) {
  if (REACHABLE.has((e.status ?? "").toLowerCase())) {
    const em = (e.to ?? "").toLowerCase().trim();
    if (em) deliveredRecipientsSet.add(em);
  }
}
console.log(`unique delivered recipients (emails.to in REACHABLE): ${deliveredRecipientsSet.size}`);

const { data: wcAdmin } = await sb.from("brief_lookups").select("query").eq("added_wechat", true);
const wcCount = wcAdmin?.length ?? 0;
const conversionRate = deliveredRecipientsSet.size > 0 ? ((wcCount / deliveredRecipientsSet.size) * 100).toFixed(1) : 0;
console.log(`org conversionRate: wechat=${wcCount} / delivered=${deliveredRecipientsSet.size} = ${conversionRate}%`);

// ────────────────────────────────────────────────────────────────────────
section("E. v_mission_today schema");
// ────────────────────────────────────────────────────────────────────────
const { data: missionsToday, error: mErr } = await sb.from("v_mission_today").select("*");
if (mErr) {
  console.log(`ERROR: ${mErr.message}`);
} else {
  console.log(`v_mission_today: ${missionsToday?.length ?? 0} rows`);
  if (missionsToday && missionsToday.length > 0) {
    console.log("columns:", Object.keys(missionsToday[0]));
    for (const m of missionsToday.slice(0, 10)) {
      console.log(`  rep=${m.rep_id} kind=${m.kind} target=${m.target} progress=${m.progress ?? "?"} progress_count=${m.progress_count ?? "?"} status=${m.status ?? "?"}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
section("F. last_activity_at sanity per rep");
// ────────────────────────────────────────────────────────────────────────
for (const r of reps ?? []) {
  if (!repIds.includes(r.id)) continue;
  const { data: lastEmail } = await sb.from("emails").select("created_at").eq("actor_rep_id", r.id).order("created_at", { ascending: false }).limit(1);
  const { data: lastEch } = await sb.from("email_contact_history").select("received_at").eq("rep_id", r.id).order("received_at", { ascending: false }).limit(1);
  const ts1 = lastEmail?.[0]?.created_at ?? "(none)";
  const ts2 = lastEch?.[0]?.received_at ?? "(none)";
  console.log(`  ${r.name?.padEnd(12)}  emails.last=${ts1?.slice(0, 19)}  ech.last=${ts2?.slice(0, 19)}`);
}

// ────────────────────────────────────────────────────────────────────────
section("G. email_contact_history shape sanity");
// ────────────────────────────────────────────────────────────────────────
const { data: echSample } = await sb.from("email_contact_history").select("*").limit(3);
if (echSample && echSample.length > 0) {
  console.log("ech columns:", Object.keys(echSample[0]));
  console.log("sample row:", echSample[0]);
}
const { count: echInboundCount } = await sb.from("email_contact_history").select("*", { count: "exact", head: true }).eq("direction", "inbound");
const { count: echOutboundCount } = await sb.from("email_contact_history").select("*", { count: "exact", head: true }).eq("direction", "outbound");
const { count: echNullDir } = await sb.from("email_contact_history").select("*", { count: "exact", head: true }).is("direction", null);
console.log(`ech direction=inbound  : ${echInboundCount}`);
console.log(`ech direction=outbound : ${echOutboundCount}`);
console.log(`ech direction IS NULL  : ${echNullDir}`);

// Does ech have an inbound direction value at all?
const { data: dirDistinct } = await sb.from("email_contact_history").select("direction").limit(1000);
const dirSet = new Set((dirDistinct ?? []).map((r) => r.direction));
console.log(`distinct direction values (first 1000):`, [...dirSet]);

// ────────────────────────────────────────────────────────────────────────
section("H. Pipeline analytics 'sent' for a rep — verify vs per-rep API");
// ────────────────────────────────────────────────────────────────────────
// fetchRepRecipientCounts: emails grouped by from→{to set}
const repBySender = new Map();
for (const e of allEmails) {
  const s = (e.status ?? "").toLowerCase();
  if (!REACHABLE.has(s)) continue;
  const m = (e.from ?? "").match(/<([^>]+)>/);
  const fromAddr = (m ? m[1] : (e.from ?? "")).toLowerCase().trim();
  if (!fromAddr || !fromAddr.includes("@")) continue;
  const toAddr = (e.to ?? "").toLowerCase().trim();
  if (!toAddr) continue;
  const set = repBySender.get(fromAddr) ?? new Set();
  set.add(toAddr);
  repBySender.set(fromAddr, set);
}
for (const r of reps ?? []) {
  if (!repIds.includes(r.id)) continue;
  const senderEmail = (r.sender_email ?? "").toLowerCase().trim();
  const recipientSet = repBySender.get(senderEmail) ?? new Set();
  // pipeline_leads scoped to this rep with REACHABLE status
  const repLeads = allLeads.filter((l) => l.assigned_rep_id === r.id);
  const repLeadsContacted = repLeads.filter((l) => CONTACTED.includes(l.status));
  console.log(`  ${r.name?.padEnd(12)}  pipeline_leads.assigned=${repLeads.length}  pipeline_leads.sent_status=${repLeadsContacted.length}  emails.from-ilike-recipients=${recipientSet.size}`);
}

console.log("\n=== audit pt 2 complete ===");

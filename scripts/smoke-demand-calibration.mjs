// Smoke for demand calibration. Calls the same SQL-based logic that
// calibrateModels() runs, on real production data, and prints the
// per-model calibration scores.

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const W = { click: 1, click_multi: 0.5, click_dedup_min: 5, wechat: 3, reply: 5 };

function pearson(xs, ys) {
  const n = xs.length; if (!n) return 0;
  const mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n;
  let num=0,dx=0,dy=0;
  for (let i=0;i<n;i++) { num += (xs[i]-mx)*(ys[i]-my); dx+=(xs[i]-mx)**2; dy+=(ys[i]-my)**2; }
  return (dx===0||dy===0) ? 0 : num/Math.sqrt(dx*dy);
}
function ranks(xs) { const ix = xs.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v); const r=new Array(xs.length); for(let i=0;i<ix.length;i++) r[ix[i].i]=i+1; return r; }
const spearman = (xs,ys) => pearson(ranks(xs), ranks(ys));

const since = new Date(Date.now() - 60*86400000).toISOString();
const { data: leads } = await sb.from("pipeline_leads")
  .select("id, author_email, local_score, lead_tier, citation_count, h_index, status, sent_at")
  .gte("sent_at", since).in("status", ["sent","replied","skipped"]).order("sent_at", { ascending: false }).limit(300);

if (!leads?.length) { console.log("No recently-sent leads — nothing to calibrate."); process.exit(0); }
console.log(`Calibrating on ${leads.length} leads, last 60 days.\n`);

// Compute observed strength per lead. Bulk pulls.
const emails = leads.map(l => l.author_email.toLowerCase());
const { data: emailRows } = await sb.from("emails").select("id, to").or(emails.map(e => `to.ilike.%${e}%`).join(","));
const emailIdToLead = new Map();
for (const er of emailRows ?? []) {
  const m = er.to.toLowerCase();
  for (const l of leads) if (m.includes(l.author_email.toLowerCase())) { emailIdToLead.set(er.id, l.id); break; }
}
const emailIds = [...emailIdToLead.keys()];

const opensByLead = new Map(); const clicksByLead = new Map();
if (emailIds.length) {
  const { data: events } = await sb.from("webhook_events").select("type, payload, email_id").in("email_id", emailIds);
  for (const ev of events ?? []) {
    const lid = emailIdToLead.get(ev.email_id);
    if (!lid) continue;
    if (ev.type === "email.opened") opensByLead.set(lid, (opensByLead.get(lid)??0) + 1);
    else if (ev.type === "email.clicked") {
      const c = (ev.payload?.data?.click) ?? {};
      if (!clicksByLead.has(lid)) clicksByLead.set(lid, []);
      clicksByLead.get(lid).push({ ip: c.ipAddress, ts: c.timestamp ?? "", link: c.link });
    }
  }
}

const { data: wechats } = await sb.from("brief_lookups").select("lead_id").eq("added_wechat", true).in("lead_id", leads.map(l=>l.id));
const wechatLeads = new Set((wechats??[]).map(w=>w.lead_id));

const { data: replies } = await sb.from("inbound_emails").select("from").in("from", emails);
const replyEmails = new Set((replies??[]).map(r=>r.from.toLowerCase()));

const strength = new Map();
for (const l of leads) {
  const opens = opensByLead.get(l.id) ?? 0;
  const clicks = clicksByLead.get(l.id) ?? [];
  const winMs = W.click_dedup_min * 60_000;
  const sorted = [...clicks].sort((a,b)=>new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const dedup = [];
  for (const c of sorted) {
    const last = dedup[dedup.length-1];
    if (last && last.ip === c.ip && Math.abs(new Date(c.ts).getTime() - new Date(last.ts).getTime()) < winMs) continue;
    dedup.push(c);
  }
  const clickN = dedup.length;
  const wechat = wechatLeads.has(l.id) ? 1 : 0;
  const reply = replyEmails.has(l.author_email.toLowerCase()) ? 1 : 0;
  let s = 0;
  if (clickN >= 1) s += W.click;
  if (clickN >= 2) s += (clickN - 1) * W.click * W.click_multi;
  s += wechat * W.wechat;
  s += reply * W.reply;
  strength.set(l.id, { observed: s, clickN, wechat, reply, opens });
}

// Calibrate each model
const models = [
  { name: "local_score", get: l => l.local_score != null ? Number(l.local_score) : null },
  { name: "lead_tier", get: l => l.lead_tier === "strong" ? 1.0 : l.lead_tier === "normal" ? 0.5 : null },
  { name: "citation_log", get: l => l.citation_count != null ? Math.log10(Math.max(1, Number(l.citation_count)+1))/4 : null },
  { name: "h_index_norm", get: l => l.h_index != null ? Math.min(1, Number(l.h_index)/50) : null },
];

console.log(`${"Model".padEnd(20)} ${"n".padEnd(5)} ${"Pearson".padEnd(10)} ${"Spearman".padEnd(10)} top-3 misses (predicted/actual)`);
console.log("─".repeat(80));
for (const m of models) {
  const pairs = [];
  for (const l of leads) {
    const p = m.get(l), s = strength.get(l.id);
    if (p == null || !s) continue;
    pairs.push({ lead_id: l.id, predicted: p, actual: s.observed });
  }
  if (pairs.length < 5) { console.log(`${m.name.padEnd(20)} ${String(pairs.length).padEnd(5)} (insufficient data)`); continue; }
  const xs = pairs.map(p=>p.predicted), ys = pairs.map(p=>p.actual);
  const minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
  const rX=Math.max(1e-6, maxX-minX), rY=Math.max(1e-6, maxY-minY);
  const withDiff = pairs.map(p => ({ ...p, ndiff: ((p.actual-minY)/rY) - ((p.predicted-minX)/rX) }));
  const top3 = [...withDiff].sort((a,b)=>Math.abs(b.ndiff)-Math.abs(a.ndiff)).slice(0,3);
  console.log(`${m.name.padEnd(20)} ${String(pairs.length).padEnd(5)} ${pearson(xs,ys).toFixed(3).padEnd(10)} ${spearman(xs,ys).toFixed(3).padEnd(10)} ${top3.map(t=>`${t.predicted.toFixed(2)}/${t.actual.toFixed(1)}`).join(" ")}`);
}

console.log(`\n=== calibration computed for ${leads.length} leads ===`);

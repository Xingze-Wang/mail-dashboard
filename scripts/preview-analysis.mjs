// Local preview of what /api/analysis returns. Computes adaptive
// breakdowns directly against Supabase REST so we can sanity-check
// the dashboard without spinning up the dev server.

import { createClient } from "@supabase/supabase-js";

const url = "https://erguqrisqtugfysofwdd.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM";
const sb = createClient(url, key);

const CONTACTED = new Set(["sent", "replied", "wechat_added"]);
const MIN_BUCKET_N = 10;

// Load leads (paginated to be safe).
const allLeads = [];
let cursor = 0;
while (true) {
  const r = await sb.from("pipeline_leads").select(
    "id, status, author_email, matched_directions, compute_level, school_tier, h_index, citation_count, industry_orgs, local_score, lead_tier, published_at, source"
  ).range(cursor, cursor + 999);
  if (r.error || !r.data || r.data.length === 0) break;
  allLeads.push(...r.data);
  if (r.data.length < 1000) break;
  cursor += 1000;
}

// Load wechat lead_ids
const w = await sb.from("brief_lookups").select("lead_id").eq("added_wechat", true).not("lead_id", "is", null);
const wechatIds = new Set((w.data ?? []).map(r => r.lead_id));

const totalSent = allLeads.filter(l => CONTACTED.has(l.status)).length;
const totalReplied = allLeads.filter(l => l.status === "replied").length;
const totalWechat = allLeads.filter(l => wechatIds.has(l.id)).length;
const baseW = totalSent > 0 ? totalWechat / totalSent : 0;
const baseR = totalSent > 0 ? totalReplied / totalSent : 0;

console.log(`Population: ${allLeads.length} | Sent: ${totalSent} | Replied: ${totalReplied} | WeChat: ${totalWechat}`);
console.log(`Baseline WeChat rate: ${(baseW*100).toFixed(2)}% | Reply rate: ${(baseR*100).toFixed(2)}%`);
console.log();

function loc(email) {
  if (!email || !email.includes("@")) return "unknown";
  const d = email.split("@")[1].toLowerCase();
  if (d.endsWith(".cn")) return "CN";
  if (d.endsWith(".hk")) return "HK";
  if (d.endsWith(".sg")) return "SG";
  if (d.endsWith(".jp")) return "JP";
  if (d.endsWith(".uk")) return "UK";
  if (d.endsWith(".de")) return "DE";
  if (d.endsWith(".edu")) return "US (.edu)";
  return "other";
}
function primaryDir(md) {
  if (!md) return null;
  if (Array.isArray(md)) return md[0];
  return md.split(",")[0].trim() || null;
}

const dims = {
  location: l => loc(l.author_email),
  direction: l => primaryDir(l.matched_directions),
  compute_level: l => l.compute_level,
  lead_tier: l => l.lead_tier,
  industry: l => (l.industry_orgs && l.industry_orgs.length > 0 ? "industry" : "academic"),
};

for (const [name, fn] of Object.entries(dims)) {
  const groups = new Map();
  for (const l of allLeads) {
    const b = fn(l);
    if (!b) continue;
    const arr = groups.get(b) ?? [];
    arr.push(l);
    groups.set(b, arr);
  }
  const rows = [];
  for (const [bucket, arr] of groups) {
    const sent = arr.filter(l => CONTACTED.has(l.status)).length;
    const wechat = arr.filter(l => wechatIds.has(l.id)).length;
    const replied = arr.filter(l => l.status === "replied").length;
    if (sent < MIN_BUCKET_N) continue;
    const wRate = sent > 0 ? wechat/sent : 0;
    const rRate = sent > 0 ? replied/sent : 0;
    rows.push({ bucket, sent, replied, wechat, wRate, rRate, lift: baseW > 0 ? wRate/baseW : 0 });
  }
  if (rows.length === 0) continue;
  rows.sort((a,b) => b.lift - a.lift);
  console.log(`### ${name}`);
  console.log("  bucket                 sent  rep  wec  reply%  wechat%  lift");
  for (const r of rows) {
    console.log(
      "  " +
      r.bucket.padEnd(22).slice(0,22) +
      String(r.sent).padStart(5) +
      String(r.replied).padStart(5) +
      String(r.wechat).padStart(5) +
      "  " + (r.rRate*100).toFixed(1).padStart(5) + "%" +
      "  " + (r.wRate*100).toFixed(1).padStart(6) + "%" +
      "  " + r.lift.toFixed(2) + "x"
    );
  }
  console.log();
}

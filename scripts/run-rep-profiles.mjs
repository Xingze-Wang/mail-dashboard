// Trigger rep profile recompute against prod DB.
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

function geoBinary(addr) {
  return addr.split("@")[1]?.toLowerCase().endsWith(".cn") ? "Domestic (.cn)" : "Overseas";
}

const { data: reps } = await sb.from("sales_reps").select("id, sender_email, name").eq("active", true);
console.log("reps:", reps?.length);

const since = new Date(Date.now() - 90 * 86_400_000).toISOString();

for (const rep of reps ?? []) {
  if (!rep.sender_email) continue;
  const { data: emails } = await sb
    .from("emails")
    .select("id, to, status")
    .ilike("from", `%${rep.sender_email}%`)
    .gte("created_at", since);

  const seg = {
    "Domestic (.cn)": { delivered: 0, clicked: 0, wechat: 0, ctr: 0, conv: 0, sample: 0 },
    "Overseas":       { delivered: 0, clicked: 0, wechat: 0, ctr: 0, conv: 0, sample: 0 },
  };
  for (const e of emails ?? []) {
    const m = String(e.to ?? "").toLowerCase().match(/[\w.+-]+@[\w.-]+/)?.[0];
    if (!m) continue;
    const k = geoBinary(m);
    seg[k].sample++;
    if (["delivered","opened","clicked","complained"].includes(e.status)) seg[k].delivered++;
    if (e.status === "clicked") seg[k].clicked++;
  }
  const { data: wechats } = await sb
    .from("brief_lookups")
    .select("query")
    .eq("added_wechat", true)
    .eq("marked_by_rep_id", rep.id)
    .gte("wechat_at", since);
  for (const w of wechats ?? []) {
    const m = String(w.query ?? "").toLowerCase().match(/[\w.+-]+@[\w.-]+/)?.[0];
    if (!m) continue;
    seg[geoBinary(m)].wechat++;
  }
  for (const k of Object.keys(seg)) {
    const s = seg[k];
    s.ctr = s.delivered > 0 ? Number((s.clicked / s.delivered).toFixed(4)) : 0;
    s.conv = s.clicked > 0 ? Number((s.wechat / s.clicked).toFixed(4)) : 0;
  }
  const dom = seg["Domestic (.cn)"], ovs = seg["Overseas"];
  const lines = [];
  if (dom.sample > 0) lines.push(`Domestic: ${(dom.ctr*100).toFixed(1)}% CTR, ${(dom.conv*100).toFixed(1)}% conv on ${dom.sample}`);
  if (ovs.sample > 0) lines.push(`Overseas: ${(ovs.ctr*100).toFixed(1)}% CTR, ${(ovs.conv*100).toFixed(1)}% conv on ${ovs.sample}`);
  const fit_summary = lines.length > 0 ? lines.join(" · ") : "No segment data.";

  await sb.from("rep_operating_profile").upsert({
    rep_id: rep.id,
    segment_performance: seg,
    override_rate: 0,
    override_outcomes: { wins: 0, losses: 0, neutral: 0 },
    response_speed_p50_s: null,
    fit_summary,
    recomputed_at: new Date().toISOString(),
  }, { onConflict: "rep_id" });
  console.log(`  ${rep.name}: ${fit_summary}`);
}

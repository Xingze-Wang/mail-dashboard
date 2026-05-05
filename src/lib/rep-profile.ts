// Rep operating profile recompute. Reads existing event streams and
// writes one row per rep into rep_operating_profile. Cheap aggregation;
// safe to run on every cron tick.

import { supabase } from "@/lib/db";

interface SegmentMetric {
  delivered: number;
  clicked: number;
  wechat: number;
  ctr: number;
  conv: number;
  sample: number;
}

function geoBinary(addr: string): "Domestic (.cn)" | "Overseas" {
  return addr.split("@")[1]?.toLowerCase().endsWith(".cn") ? "Domestic (.cn)" : "Overseas";
}

export async function recomputeAllRepProfiles(opts: { lookbackDays?: number } = {}): Promise<{ profiles: number }> {
  const lookback = opts.lookbackDays ?? 90;
  const since = new Date(Date.now() - lookback * 86_400_000).toISOString();

  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, sender_email")
    .eq("active", true);
  if (!reps) return { profiles: 0 };

  let written = 0;
  for (const rep of reps) {
    const senderEmail = (rep.sender_email as string | null);
    if (!senderEmail) continue;

    // Pull this rep's outbound emails in the window.
    const { data: emails } = await supabase
      .from("emails")
      .select("id, to, status, created_at")
      .ilike("from", `%${senderEmail}%`)
      .gte("created_at", since);
    if (!emails || emails.length === 0) {
      await supabase.from("rep_operating_profile").upsert({
        rep_id: rep.id,
        segment_performance: {},
        override_rate: 0,
        override_outcomes: { wins: 0, losses: 0, neutral: 0 },
        response_speed_p50_s: null,
        fit_summary: "No recent activity in window.",
        recomputed_at: new Date().toISOString(),
      }, { onConflict: "rep_id" });
      written++;
      continue;
    }

    // Bucket by segment.
    const seg: Record<string, SegmentMetric> = {
      "Domestic (.cn)": { delivered: 0, clicked: 0, wechat: 0, ctr: 0, conv: 0, sample: 0 },
      "Overseas":       { delivered: 0, clicked: 0, wechat: 0, ctr: 0, conv: 0, sample: 0 },
    };

    for (const e of emails) {
      const to = String(e.to ?? "").toLowerCase();
      const m = to.match(/[\w.+-]+@[\w.-]+/)?.[0];
      if (!m) continue;
      const segKey = geoBinary(m);
      seg[segKey].sample++;
      const st = e.status as string;
      if (st === "delivered" || st === "opened" || st === "clicked" || st === "complained") seg[segKey].delivered++;
      if (st === "clicked") seg[segKey].clicked++;
    }

    // Pull this rep's wechat conversions, count by recipient segment.
    const { data: wechats } = await supabase
      .from("brief_lookups")
      .select("query")
      .eq("added_wechat", true)
      .eq("marked_by_rep_id", rep.id)
      .gte("wechat_at", since);
    for (const w of wechats ?? []) {
      const m = String(w.query ?? "").toLowerCase().match(/[\w.+-]+@[\w.-]+/)?.[0];
      if (!m) continue;
      const segKey = geoBinary(m);
      seg[segKey].wechat++;
    }

    // Compute rates.
    for (const k of Object.keys(seg)) {
      const s = seg[k];
      s.ctr = s.delivered > 0 ? Number((s.clicked / s.delivered).toFixed(4)) : 0;
      s.conv = s.clicked > 0 ? Number((s.wechat / s.clicked).toFixed(4)) : 0;
    }

    // Fit summary in one line.
    const dom = seg["Domestic (.cn)"];
    const ovs = seg["Overseas"];
    const lines: string[] = [];
    if (dom.sample > 0) lines.push(`Domestic: ${(dom.ctr * 100).toFixed(1)}% CTR, ${(dom.conv * 100).toFixed(1)}% conv on ${dom.sample}`);
    if (ovs.sample > 0) lines.push(`Overseas: ${(ovs.ctr * 100).toFixed(1)}% CTR, ${(ovs.conv * 100).toFixed(1)}% conv on ${ovs.sample}`);
    const fit_summary = lines.length > 0 ? lines.join(" · ") : "No segment data.";

    await supabase.from("rep_operating_profile").upsert({
      rep_id: rep.id,
      segment_performance: seg,
      override_rate: 0,                                 // override path not yet wired
      override_outcomes: { wins: 0, losses: 0, neutral: 0 },
      response_speed_p50_s: null,                       // requires lead-surfaced timestamp; deferred
      fit_summary,
      recomputed_at: new Date().toISOString(),
    }, { onConflict: "rep_id" });

    written++;
  }

  return { profiles: written };
}

// GET /api/congress/history — feeds the /congress/history chart.
// Returns weekly conversion rates (last 18 weeks) + decision markers
// (every approved/rejected/reverted/measuring proposal in window).

import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireSession } from "@/lib/auth-helpers";
import { paginateAll } from "@/lib/supabase-paginate";
import { getMpSignalsForEmails } from "@/lib/canonical-counts";

export const dynamic = "force-dynamic";

function isoWeek(d: Date): number {
  const onejan = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7);
}

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sinceISO = new Date(Date.now() - 18 * 7 * 24 * 3600 * 1000).toISOString();

  // Pull all emails + brief_lookups in window. Group in JS — keeps the
  // query simple and Supabase doesn't expose date_trunc nicely via PostgREST.
  // PAGINATED past Supabase's 1000-row cap. At 1436+ emails total in 90d,
  // a single .select() under-counted weekly conversion rates by ~30%.
  const [emails, briefs, proposalsRes] = await Promise.all([
    paginateAll<{ id: string; to: string | null; created_at: string }>(
      (from, to) => supabase.from("emails")
        .select("id, to, created_at")
        .gte("created_at", sinceISO)
        .range(from, to),
    ),
    paginateAll<{ email: string | null; marked_at: string; marked_by_rep_id: number }>(
      (from, to) => supabase.from("brief_lookups")
        .select("email, marked_at, marked_by_rep_id")
        .gte("marked_at", sinceISO)
        .not("marked_by_rep_id", "is", null)
        .range(from, to),
    ),
    supabase.from("tactical_proposals")
      .select("id, title, proposed_at, ship_decision, shipped_at, decided_at, grade, expected_lift, actual_lift")
      .gte("proposed_at", sinceISO),
  ]);

  // Bucket emails by week, count distinct recipients
  const emailsByWeek = new Map<number, Set<string>>();
  for (const e of emails) {
    const wk = isoWeek(new Date(e.created_at));
    const set = emailsByWeek.get(wk) ?? new Set();
    if (e.to) set.add(String(e.to).toLowerCase());
    emailsByWeek.set(wk, set);
  }
  // Bucket brief_lookups by week (the conversion event's week) — kept for
  // back-compat conversion_rate (WeChat = brief_lookups distinct / emails distinct).
  const briefsByWeek = new Map<number, Set<string>>();
  for (const b of briefs) {
    const wk = isoWeek(new Date(b.marked_at));
    const set = briefsByWeek.get(wk) ?? new Set();
    if (b.email) set.add(String(b.email).toLowerCase());
    briefsByWeek.set(wk, set);
  }

  // Pull per-recipient MP signals once for every email we sent in the window.
  // Then for each week we intersect the week's recipient-set with the
  // signal map to derive registered / submitted / wechat distinct counts.
  // This uses the canonical signal lookup so "registered" / "submitted" /
  // "wechat" share the SAME emails denominator as conversion_rate.
  const allRecipients = new Set<string>();
  for (const set of emailsByWeek.values()) {
    for (const r of set) allRecipients.add(r);
  }
  const signalMap = allRecipients.size > 0
    ? await getMpSignalsForEmails(Array.from(allRecipients))
    : new Map();

  // Build the metrics array — every week in the window
  const startWeek = isoWeek(new Date(sinceISO));
  const endWeek = isoWeek(new Date());
  const metrics: {
    week: number;
    conversion_rate: number;
    registered_rate: number;
    submitted_rate: number;
    wechat_rate: number;
  }[] = [];
  for (let w = startWeek; w <= endWeek; w++) {
    const sent = emailsByWeek.get(w)?.size ?? 0;
    // Back-compat: WeChat distinct from brief_lookups week-of-event (lossy
    // but matches old metric). New wechat_rate below uses the signal map
    // (event-week may differ from email-week, but same denominator).
    const convertedLegacy = briefsByWeek.get(w)?.size ?? 0;
    const conversionRate = sent > 0 ? (convertedLegacy / sent) * 100 : 0;

    let registered = 0;
    let submitted = 0;
    let wechat = 0;
    const wkEmails = emailsByWeek.get(w);
    if (wkEmails && sent > 0) {
      for (const email of wkEmails) {
        const s = signalMap.get(email);
        if (!s) continue;
        // `registered` here means "got past MP front door" — that includes
        // anyone whose bucket is registered OR submitted (submitted is a
        // strict superset of registered).
        if (s.registered || s.submittedApplication) registered++;
        if (s.submittedApplication) submitted++;
        if (s.addedWechat) wechat++;
      }
    }

    metrics.push({
      week: w,
      conversion_rate: Math.round(conversionRate * 10) / 10,
      registered_rate: sent > 0 ? Math.round((registered / sent) * 1000) / 10 : 0,
      submitted_rate: sent > 0 ? Math.round((submitted / sent) * 1000) / 10 : 0,
      wechat_rate: sent > 0 ? Math.round((wechat / sent) * 1000) / 10 : 0,
    });
  }

  // Decision markers
  const markers = (proposalsRes.data ?? []).map((p) => {
    const wk = isoWeek(new Date(p.proposed_at));
    const status: "approved" | "rejected" | "reverted" | "measuring" | "pending" =
      p.grade === "miss" ? "reverted"
      : p.ship_decision === "approved" && p.grade ? "measuring"
      : p.ship_decision === "approved" ? "measuring"
      : p.ship_decision === "rejected" ? "rejected"
      : "pending";
    const lift = (p.actual_lift as { click_rate?: number } | null)?.click_rate;
    const expected = (p.expected_lift as { delta_pp?: number } | null)?.delta_pp;
    return {
      week: wk,
      proposal_id: p.id,
      title: p.title,
      status,
      outcome: lift != null ? `${(lift * 100).toFixed(2)}% click` : (expected != null ? `proj +${expected}pp` : undefined),
    };
  });

  return NextResponse.json({ metrics, markers });
}

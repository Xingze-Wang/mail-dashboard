import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/scorer/conversion
 *
 * "Will this lead add us on WeChat?" — conditional conversion rate broken
 * down by each feature we collect. Not a learned model (sample size is tiny,
 * any LR would overfit immediately). Instead: for each feature bucket, show
 * `converted / sent` so admins can SEE which features predict conversion
 * and eyeball the lift.
 *
 * Features covered:
 *   - local_score bucket (4 bins)
 *   - lead_tier (strong / normal / weak)
 *   - citation_count bucket
 *   - school_tier
 *   - assigned_rep_id
 *   - primary direction
 *   - day-of-week sent
 *
 * Also returns a simple "top predictive feature" ranking by lift above
 * baseline, so the UI can highlight what matters.
 */

interface LeadRow {
  id: string;
  author_email: string | null;
  local_score: number | null;
  lead_tier: string | null;
  citation_count: number | null;
  school_tier: number | null;
  assigned_rep_id: number | null;
  matched_directions: string | null;
  status: string;
  sent_at: string | null;
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  const { data: leadsRaw, error } = await supabase
    .from("pipeline_leads")
    .select(
      "id, author_email, local_score, lead_tier, citation_count, school_tier, assigned_rep_id, matched_directions, status, sent_at",
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const leads = (leadsRaw ?? []) as LeadRow[];

  const { data: wechatRaw } = await supabase
    .from("brief_lookups")
    .select("query")
    .eq("added_wechat", true);
  const wechatEmails = new Set(
    (wechatRaw ?? [])
      .map((w) => (w.query as string | null)?.toLowerCase())
      .filter(Boolean) as string[],
  );

  // Only consider leads that were actually sent — otherwise we're diluting
  // with not-yet-reached people.
  const sent = leads.filter((l) =>
    l.status === "sent" || l.status === "replied" || l.status === "wechat_added",
  );
  const totalSent = sent.length;
  const totalConverted = sent.filter((l) =>
    wechatEmails.has((l.author_email ?? "").toLowerCase()),
  ).length;
  const baseline = totalSent > 0 ? totalConverted / totalSent : 0;

  // Generic bucketing helper: returns [{ bucket, sent, converted, rate, lift }]
  type Bucketed = { bucket: string; sent: number; converted: number; rate: number; lift: number };
  function bucketize(
    keyFn: (l: LeadRow) => string | null,
    ordering?: string[],
  ): Bucketed[] {
    const m = new Map<string, { sent: number; converted: number }>();
    for (const l of sent) {
      const k = keyFn(l);
      if (k === null) continue;
      const entry = m.get(k) ?? { sent: 0, converted: 0 };
      entry.sent++;
      if (wechatEmails.has((l.author_email ?? "").toLowerCase())) entry.converted++;
      m.set(k, entry);
    }
    const rows: Bucketed[] = Array.from(m.entries()).map(([bucket, v]) => ({
      bucket,
      sent: v.sent,
      converted: v.converted,
      rate: v.sent > 0 ? Math.round((v.converted / v.sent) * 1000) / 10 : 0,
      lift: baseline > 0 && v.sent >= 3 ? Math.round(((v.converted / v.sent) / baseline) * 100) / 100 : 0,
    }));
    if (ordering) {
      const order = new Map(ordering.map((o, i) => [o, i]));
      rows.sort((a, b) => (order.get(a.bucket) ?? 99) - (order.get(b.bucket) ?? 99));
    } else {
      rows.sort((a, b) => b.sent - a.sent);
    }
    return rows;
  }

  // score bucket
  const scoreBucket = bucketize((l) => {
    if (typeof l.local_score !== "number") return null;
    if (l.local_score >= 0.7) return "0.70-1.00";
    if (l.local_score >= 0.5) return "0.50-0.70";
    if (l.local_score >= 0.3) return "0.30-0.50";
    return "0.00-0.30";
  }, ["0.70-1.00", "0.50-0.70", "0.30-0.50", "0.00-0.30"]);

  // lead tier
  const tierBucket = bucketize((l) => l.lead_tier ?? "unknown", ["strong", "normal", "weak", "unknown"]);

  // citations
  const citeBucket = bucketize((l) => {
    if (typeof l.citation_count !== "number") return "(unknown)";
    if (l.citation_count >= 1000) return "1000+";
    if (l.citation_count >= 100) return "100-1000";
    if (l.citation_count >= 10) return "10-100";
    return "< 10";
  }, ["1000+", "100-1000", "10-100", "< 10", "(unknown)"]);

  // school tier
  const schoolBucket = bucketize((l) => {
    if (l.school_tier === 1) return "Tier 1";
    if (l.school_tier === 2) return "Tier 2";
    if (l.school_tier === 3) return "Tier 3";
    return "(unknown)";
  }, ["Tier 1", "Tier 2", "Tier 3", "(unknown)"]);

  // rep
  const repBucket = bucketize((l) =>
    l.assigned_rep_id !== null ? `rep ${l.assigned_rep_id}` : "(unassigned)",
  );

  // direction — take first of matched_directions
  const dirBucket = bucketize((l) => {
    const raw = l.matched_directions;
    if (!raw) return "(none)";
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return String(parsed[0]);
    } catch {
      // not JSON — treat as plain string, take before comma
    }
    return String(raw).split(",")[0].trim() || "(none)";
  }).slice(0, 10);

  // day-of-week sent
  const dayBucket = bucketize((l) => {
    if (!l.sent_at) return null;
    const d = new Date(l.sent_at).getUTCDay();
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d];
  }, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

  // Top predictive features = biggest |lift - 1| with sent >= 3
  const allBuckets = [
    ...scoreBucket.map((b) => ({ ...b, feature: "local_score" })),
    ...tierBucket.map((b) => ({ ...b, feature: "lead_tier" })),
    ...citeBucket.map((b) => ({ ...b, feature: "citations" })),
    ...schoolBucket.map((b) => ({ ...b, feature: "school_tier" })),
    ...repBucket.map((b) => ({ ...b, feature: "assigned_rep" })),
    ...dirBucket.map((b) => ({ ...b, feature: "direction" })),
    ...dayBucket.map((b) => ({ ...b, feature: "sent_day" })),
  ];
  const topLift = allBuckets
    .filter((b) => b.sent >= 3 && b.lift > 0)
    .sort((a, b) => Math.abs(b.lift - 1) - Math.abs(a.lift - 1))
    .slice(0, 6);

  return NextResponse.json({
    baseline: Math.round(baseline * 1000) / 10,
    totalSent,
    totalConverted,
    byScore: scoreBucket,
    byTier: tierBucket,
    byCitations: citeBucket,
    bySchoolTier: schoolBucket,
    byRep: repBucket,
    byDirection: dirBucket,
    byDay: dayBucket,
    topLift,
  });
}

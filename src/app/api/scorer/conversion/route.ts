import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/scorer/conversion
 *
 * Recipient-centric conversion analysis. Ground truth = `emails` table (the
 * real Resend send log, ~1100 rows). pipeline_leads is only ~30 rows and
 * most actual sends never went through it, so if we scoped the baseline to
 * pipeline leads we'd report a conversion rate 30× too high.
 *
 * For each unique recipient in `emails` (excluding bounced), we try to pull
 * features from pipeline_leads by joining on author_email. When there's no
 * pipeline row (most of our history), the recipient still counts toward the
 * baseline but lands in an "(no pipeline data)" bucket for feature breakdowns.
 *
 * Conversion = recipient appears in brief_lookups with added_wechat=true.
 */

interface LeadRow {
  author_email: string | null;
  local_score: number | null;
  lead_tier: string | null;
  citation_count: number | null;
  school_tier: number | null;
  assigned_rep_id: number | null;
  matched_directions: string | null;
}

interface EmailRow {
  to: string | null;
  status: string | null;
  created_at: string | null;
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req);
  if ("response" in gate) return gate.response;

  // ── Page-through all emails (Supabase caps REST at 1000 per request) ──
  const allEmails: EmailRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("emails")
      .select("to, status, created_at")
      .range(from, from + pageSize - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const page = (data ?? []) as EmailRow[];
    allEmails.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
    if (from > 20_000) break; // safety cap
  }

  // Only count sends that actually landed in an inbox — bounced doesn't
  // count toward the denominator because the recipient never saw it.
  const deliveredEmails = allEmails.filter((e) =>
    e.status === "delivered" || e.status === "clicked" || e.status === "sent" || e.status === "replied",
  );
  const firstByRecipient = new Map<string, EmailRow>();
  for (const e of deliveredEmails) {
    const em = (e.to ?? "").toLowerCase().trim();
    if (!em) continue;
    const prev = firstByRecipient.get(em);
    if (!prev || (e.created_at && prev.created_at && e.created_at < prev.created_at)) {
      firstByRecipient.set(em, e);
    }
  }

  // ── Pull pipeline_leads features for any recipient we can match ──
  const { data: leadsRaw } = await supabase
    .from("pipeline_leads")
    .select("author_email, local_score, lead_tier, citation_count, school_tier, assigned_rep_id, matched_directions");
  const leadsByEmail = new Map<string, LeadRow>();
  for (const l of (leadsRaw ?? []) as LeadRow[]) {
    const em = (l.author_email ?? "").toLowerCase().trim();
    if (em) leadsByEmail.set(em, l);
  }

  // ── WeChat conversions ──
  const { data: wechatRaw } = await supabase
    .from("brief_lookups")
    .select("query")
    .eq("added_wechat", true);
  const wechatEmails = new Set(
    (wechatRaw ?? [])
      .map((w) => (w.query as string | null)?.toLowerCase().trim())
      .filter(Boolean) as string[],
  );

  // ── Build the unified recipient list — this is our denominator ──
  type Recipient = {
    email: string;
    sentAt: string | null;
    lead: LeadRow | null;
    converted: boolean;
  };
  const recipients: Recipient[] = [];
  for (const [em, e] of firstByRecipient) {
    recipients.push({
      email: em,
      sentAt: e.created_at,
      lead: leadsByEmail.get(em) ?? null,
      converted: wechatEmails.has(em),
    });
  }

  const totalSent = recipients.length;
  const totalConverted = recipients.filter((r) => r.converted).length;
  const baseline = totalSent > 0 ? totalConverted / totalSent : 0;

  // ── Bucketing helper — same shape as before ──
  type Bucketed = { bucket: string; sent: number; converted: number; rate: number; lift: number };
  function bucketize(
    keyFn: (r: Recipient) => string | null,
    ordering?: string[],
  ): Bucketed[] {
    const m = new Map<string, { sent: number; converted: number }>();
    for (const r of recipients) {
      const k = keyFn(r);
      if (k === null) continue;
      const entry = m.get(k) ?? { sent: 0, converted: 0 };
      entry.sent++;
      if (r.converted) entry.converted++;
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

  const scoreBucket = bucketize((r) => {
    if (!r.lead || typeof r.lead.local_score !== "number") return "(no pipeline data)";
    if (r.lead.local_score >= 0.7) return "0.70-1.00";
    if (r.lead.local_score >= 0.5) return "0.50-0.70";
    if (r.lead.local_score >= 0.3) return "0.30-0.50";
    return "0.00-0.30";
  }, ["0.70-1.00", "0.50-0.70", "0.30-0.50", "0.00-0.30", "(no pipeline data)"]);

  const tierBucket = bucketize((r) => {
    if (!r.lead) return "(no pipeline data)";
    return r.lead.lead_tier ?? "unknown";
  }, ["strong", "normal", "weak", "unknown", "(no pipeline data)"]);

  const citeBucket = bucketize((r) => {
    if (!r.lead) return "(no pipeline data)";
    if (typeof r.lead.citation_count !== "number") return "(unknown)";
    if (r.lead.citation_count >= 1000) return "1000+";
    if (r.lead.citation_count >= 100) return "100-1000";
    if (r.lead.citation_count >= 10) return "10-100";
    return "< 10";
  }, ["1000+", "100-1000", "10-100", "< 10", "(unknown)", "(no pipeline data)"]);

  const schoolBucket = bucketize((r) => {
    if (!r.lead) return "(no pipeline data)";
    if (r.lead.school_tier === 1) return "Tier 1";
    if (r.lead.school_tier === 2) return "Tier 2";
    if (r.lead.school_tier === 3) return "Tier 3";
    return "(unknown)";
  }, ["Tier 1", "Tier 2", "Tier 3", "(unknown)", "(no pipeline data)"]);

  const repBucket = bucketize((r) => {
    if (!r.lead || r.lead.assigned_rep_id === null) return "(unassigned)";
    return `rep ${r.lead.assigned_rep_id}`;
  });

  const dirBucket = bucketize((r) => {
    if (!r.lead) return null;
    const raw = r.lead.matched_directions;
    if (!raw) return "(none)";
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return String(parsed[0]);
    } catch {
      // plain string
    }
    return String(raw).split(",")[0].trim() || "(none)";
  }).slice(0, 10);

  // Email domain — useful even when we have no pipeline data
  const domainBucket = bucketize((r) => {
    const parts = r.email.split("@");
    if (parts.length !== 2) return "(invalid)";
    const domain = parts[1];
    if (domain.endsWith(".cn")) return ".cn (domestic)";
    if (domain.endsWith(".edu")) return ".edu (US)";
    if (domain.endsWith(".gov")) return ".gov";
    if (/\.(com|org|net)$/.test(domain)) return "commercial";
    return "other";
  });

  const dayBucket = bucketize((r) => {
    if (!r.sentAt) return null;
    const d = new Date(r.sentAt).getUTCDay();
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d];
  }, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

  // Top predictive features (excluding "(no pipeline data)" buckets — those
  // are a known unknown, not a predictive signal)
  const allBuckets = [
    ...scoreBucket.map((b) => ({ ...b, feature: "local_score" })),
    ...tierBucket.map((b) => ({ ...b, feature: "lead_tier" })),
    ...citeBucket.map((b) => ({ ...b, feature: "citations" })),
    ...schoolBucket.map((b) => ({ ...b, feature: "school_tier" })),
    ...repBucket.map((b) => ({ ...b, feature: "assigned_rep" })),
    ...dirBucket.map((b) => ({ ...b, feature: "direction" })),
    ...domainBucket.map((b) => ({ ...b, feature: "domain" })),
    ...dayBucket.map((b) => ({ ...b, feature: "sent_day" })),
  ];
  const topLift = allBuckets
    .filter((b) => b.sent >= 5 && b.lift > 0 && !b.bucket.startsWith("(no pipeline"))
    .sort((a, b) => Math.abs(b.lift - 1) - Math.abs(a.lift - 1))
    .slice(0, 6);

  // Coverage — how many of the sent recipients do we have pipeline features for?
  const withLeadData = recipients.filter((r) => r.lead !== null).length;

  return NextResponse.json({
    baseline: Math.round(baseline * 1000) / 10,
    totalSent,
    totalConverted,
    withLeadData,
    coverage: totalSent > 0 ? Math.round((withLeadData / totalSent) * 1000) / 10 : 0,
    byScore: scoreBucket,
    byTier: tierBucket,
    byCitations: citeBucket,
    bySchoolTier: schoolBucket,
    byRep: repBucket,
    byDirection: dirBucket,
    byDomain: domainBucket,
    byDay: dayBucket,
    topLift,
  });
}

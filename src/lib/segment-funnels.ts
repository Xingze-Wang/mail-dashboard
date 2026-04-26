// Two-stage segment funnels — answer the question "where in the funnel
// does this segment win or lose?"
//
// The shape we care about is NOT just one number ("conversion rate"),
// but TWO rates per segment:
//   CTR              = clicked / delivered      (top-of-funnel — earned the open + click)
//   click→wechat     = wechat / clicked          (bottom-of-funnel — earned the relationship)
//
// A segment with high CTR + low click→wechat tells you the OPENER works
// but the body/CTA doesn't convert curiosity into action — rewrite the
// pitch. The opposite (low CTR + high click→wechat) means the audience
// is qualified but the subject line / first paragraph isn't earning
// the click — rewrite the opener. Without both numbers the same
// "low conversion" diagnosis points at totally different fixes.
//
// Confirmed from real data (2026-04): overseas readers click 3.7× more
// than domestic but convert 3.2× less per click. End-to-end the rates
// flip. That single comparison rewrites how we should write each
// audience differently.

import { supabase } from "@/lib/db";

const REACHABLE_STATUSES = new Set(["sent", "delivered", "clicked", "complained", "bounced", "replied"]);
const DELIVERED_STATUSES = new Set(["delivered", "clicked", "complained"]);

interface EmailRow {
  to: string | null;
  from: string | null;
  status: string | null;
  created_at: string | null;
}

interface LeadFeatures {
  email: string;
  school_tier: number | null;
  lead_tier: string | null;
  h_index: number | null;
  citation_count: number | null;
  matched_directions: string | string[] | null;
  assigned_rep_id: number | null;
}

export interface SegmentStats {
  segment: string;
  delivered: number;
  clicked: number;
  wechat: number;
  ctr: number;            // clicked / delivered
  postClickConv: number;  // wechat / clicked
  endToEnd: number;       // wechat / delivered
  /** True when any rate is computed on too-small N to trust. */
  lowN: boolean;
}

export interface SegmentDimension {
  dimension: string;
  label: string;
  segments: SegmentStats[];
}

const MIN_DELIVERED_FOR_CTR = 20;
const MIN_CLICKED_FOR_CONV = 5;

function locationFromEmail(em: string): string {
  const d = em.split("@")[1] || "";
  if (d.endsWith(".cn")) return "Domestic (.cn)";
  if (d.endsWith(".hk")) return "Hong Kong (.hk)";
  if (d.endsWith(".edu")) return "US (.edu)";
  if (d.endsWith(".sg")) return "Singapore (.sg)";
  if (d.endsWith(".jp") || d.endsWith(".kr")) return "Other Asia";
  if (d.endsWith(".uk") || d.endsWith(".de") || d.endsWith(".fr") || d.endsWith(".ca") || d.endsWith(".au")) return "Other West";
  return "Other";
}

function geoBinary(em: string): string {
  return (em.split("@")[1] || "").toLowerCase().endsWith(".cn") ? "Domestic (.cn)" : "Overseas";
}

function hIndexBucket(h: number | null): string {
  if (h == null) return "(unknown)";
  if (h >= 50) return "h ≥ 50";
  if (h >= 20) return "h 20-49";
  if (h >= 10) return "h 10-19";
  if (h >= 5) return "h 5-9";
  return "h < 5";
}

function citationsBucket(c: number | null): string {
  if (c == null) return "(unknown)";
  if (c >= 1000) return "1000+";
  if (c >= 100) return "100-999";
  if (c >= 10) return "10-99";
  return "< 10";
}

function schoolTierLabel(t: number | null): string {
  if (t === 1) return "Tier 1";
  if (t === 2) return "Tier 2";
  if (t === 3) return "Tier 3";
  return "(unknown)";
}

function firstDirection(raw: string | string[] | null): string {
  if (!raw) return "(none)";
  if (Array.isArray(raw)) return raw[0] || "(none)";
  try {
    const p = JSON.parse(raw);
    if (Array.isArray(p) && p.length > 0) return String(p[0]);
  } catch { /* not JSON */ }
  return String(raw).split(",")[0].trim() || "(none)";
}

interface LoadOpts {
  repId?: number | null;          // scope by sending rep (admin: null = org-wide)
  lookbackDays?: number | null;
}

export interface SegmentFunnels {
  scope: { repId: number | null; lookbackDays: number | null };
  totals: {
    delivered: number;
    clicked: number;
    wechat: number;
    overallCtr: number;
    overallPostClick: number;
  };
  dimensions: SegmentDimension[];
}

export async function computeSegmentFunnels(opts: LoadOpts = {}): Promise<SegmentFunnels> {
  const { repId = null, lookbackDays = null } = opts;
  const cutoff = lookbackDays
    ? new Date(Date.now() - lookbackDays * 86_400_000).toISOString()
    : null;

  // 1. Load emails, paginated. Postgrest caps a single response at 1000.
  // Filter by sender if scoped to a rep (their sender_email).
  let senderFilter: string | null = null;
  if (repId) {
    const { data: rep } = await supabase.from("sales_reps").select("sender_email").eq("id", repId).maybeSingle();
    if (rep?.sender_email) senderFilter = rep.sender_email;
  }

  const allEmails: EmailRow[] = [];
  let cursor = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase
      .from("emails")
      .select("to, from, status, created_at")
      .order("created_at", { ascending: false })
      .range(cursor, cursor + pageSize - 1);
    if (cutoff) q = q.gte("created_at", cutoff);
    if (senderFilter) q = q.ilike("from", `%${senderFilter}%`);
    const { data, error } = await q;
    if (error || !data || data.length === 0) break;
    allEmails.push(...(data as EmailRow[]));
    if (data.length < pageSize) break;
    cursor += pageSize;
    if (cursor > 100_000) break;
  }

  // 2. Load WeChat-marked recipients. Same scope.
  let wechatQ = supabase
    .from("brief_lookups")
    .select("query, lead_id, marked_by_rep_id, wechat_at, created_at")
    .eq("added_wechat", true);
  if (repId) wechatQ = wechatQ.eq("marked_by_rep_id", repId);
  if (cutoff) wechatQ = wechatQ.gte("created_at", cutoff);
  const { data: wcRows } = await wechatQ;
  const wechatRecipients = new Set<string>();
  for (const w of wcRows ?? []) {
    const q = (w.query as string | null)?.toLowerCase().trim() ?? "";
    if (q.includes("@")) wechatRecipients.add(q);
  }

  // 3. Load lead features keyed by lowercased author_email — for cross-axis
  // dimensions (school tier, h-index, etc) the features come from
  // pipeline_leads, joined to emails by recipient address.
  const { data: leadsRaw } = await supabase
    .from("pipeline_leads")
    .select("author_email, school_tier, lead_tier, h_index, citation_count, matched_directions, assigned_rep_id");
  const featureByEmail = new Map<string, LeadFeatures>();
  for (const l of leadsRaw ?? []) {
    const em = (l.author_email as string | null)?.toLowerCase().trim();
    if (!em) continue;
    featureByEmail.set(em, {
      email: em,
      school_tier: l.school_tier as number | null,
      lead_tier: l.lead_tier as string | null,
      h_index: l.h_index as number | null,
      citation_count: l.citation_count as number | null,
      matched_directions: l.matched_directions as string | string[] | null,
      assigned_rep_id: l.assigned_rep_id as number | null,
    });
  }

  // 4. Build per-recipient state. We dedupe by recipient because click
  // tracking and wechat conversion are per-person, not per-send.
  type RecipientState = {
    email: string;
    delivered: boolean;
    clicked: boolean;
    wechat: boolean;
    feat: LeadFeatures | null;
  };
  const byRecipient = new Map<string, RecipientState>();
  for (const e of allEmails) {
    if (!e.to || !e.status) continue;
    if (!REACHABLE_STATUSES.has(e.status)) continue;
    const em = e.to.toLowerCase().trim();
    if (!em.includes("@")) continue;
    const cur = byRecipient.get(em) ?? {
      email: em, delivered: false, clicked: false, wechat: false,
      feat: featureByEmail.get(em) ?? null,
    };
    if (DELIVERED_STATUSES.has(e.status)) cur.delivered = true;
    if (e.status === "clicked") cur.clicked = true;
    byRecipient.set(em, cur);
  }
  for (const em of wechatRecipients) {
    const cur = byRecipient.get(em);
    if (cur) cur.wechat = true;
    // If they're in wechat but not in our emails table, they don't enter
    // the funnel — we have no denominator for them.
  }

  const recipients = [...byRecipient.values()];

  // 5. Bucket by each dimension and compute the two rates per segment.
  const bucketsBy = (keyFn: (r: RecipientState) => string): SegmentStats[] => {
    const m = new Map<string, { delivered: number; clicked: number; wechat: number }>();
    for (const r of recipients) {
      const k = keyFn(r);
      if (!k) continue;
      const cur = m.get(k) ?? { delivered: 0, clicked: 0, wechat: 0 };
      if (r.delivered) cur.delivered++;
      if (r.clicked) cur.clicked++;
      if (r.wechat) cur.wechat++;
      m.set(k, cur);
    }
    return [...m.entries()].map(([segment, v]) => {
      const ctr = v.delivered > 0 ? v.clicked / v.delivered : 0;
      const postClickConv = v.clicked > 0 ? v.wechat / v.clicked : 0;
      const endToEnd = v.delivered > 0 ? v.wechat / v.delivered : 0;
      return {
        segment,
        delivered: v.delivered, clicked: v.clicked, wechat: v.wechat,
        ctr, postClickConv, endToEnd,
        lowN: v.delivered < MIN_DELIVERED_FOR_CTR || v.clicked < MIN_CLICKED_FOR_CONV,
      };
    }).sort((a, b) => b.delivered - a.delivered);
  };

  const dimensions: SegmentDimension[] = [
    {
      dimension: "geo_binary",
      label: "Geography (binary): Domestic .cn vs Overseas",
      segments: bucketsBy((r) => geoBinary(r.email)),
    },
    {
      dimension: "geo_detail",
      label: "Geography (detailed)",
      segments: bucketsBy((r) => locationFromEmail(r.email)),
    },
    {
      dimension: "school_tier",
      label: "School tier",
      segments: bucketsBy((r) => r.feat ? schoolTierLabel(r.feat.school_tier) : "(no lead data)"),
    },
    {
      dimension: "lead_tier",
      label: "Lead tier (strong / normal)",
      segments: bucketsBy((r) => r.feat?.lead_tier ?? "(no lead data)"),
    },
    {
      dimension: "h_index",
      label: "H-index",
      segments: bucketsBy((r) => r.feat ? hIndexBucket(r.feat.h_index) : "(no lead data)"),
    },
    {
      dimension: "citations",
      label: "Citation count",
      segments: bucketsBy((r) => r.feat ? citationsBucket(r.feat.citation_count) : "(no lead data)"),
    },
    {
      dimension: "direction",
      label: "Top matched direction",
      segments: bucketsBy((r) => r.feat ? firstDirection(r.feat.matched_directions) : "(no lead data)"),
    },
  ];

  // ── Cross-axis: school tier within each geography ─────────────────
  // Adds two specific cross-segment views — these are where the "elite
  // school overrides geography" or "tier-1 .cn outperforms US .edu"
  // questions get answered concretely.
  const crossSchoolGeo: SegmentStats[] = [];
  const tiers = ["Tier 1", "Tier 2", "Tier 3", "(unknown)"];
  const geos = ["Domestic (.cn)", "Overseas"];
  for (const geo of geos) {
    for (const tier of tiers) {
      const subset = recipients.filter((r) =>
        geoBinary(r.email) === geo &&
        (r.feat ? schoolTierLabel(r.feat.school_tier) : "(unknown)") === tier
      );
      const delivered = subset.filter((r) => r.delivered).length;
      const clicked = subset.filter((r) => r.clicked).length;
      const wechat = subset.filter((r) => r.wechat).length;
      if (delivered === 0 && clicked === 0 && wechat === 0) continue;
      crossSchoolGeo.push({
        segment: `${geo} × ${tier}`,
        delivered, clicked, wechat,
        ctr: delivered > 0 ? clicked / delivered : 0,
        postClickConv: clicked > 0 ? wechat / clicked : 0,
        endToEnd: delivered > 0 ? wechat / delivered : 0,
        lowN: delivered < MIN_DELIVERED_FOR_CTR || clicked < MIN_CLICKED_FOR_CONV,
      });
    }
  }
  if (crossSchoolGeo.length > 0) {
    dimensions.push({
      dimension: "geo_x_school",
      label: "Geography × School tier (cross-axis)",
      segments: crossSchoolGeo.sort((a, b) => b.delivered - a.delivered),
    });
  }

  // ── Totals ─────────────────────────────────────────────────────
  const totalDelivered = recipients.filter((r) => r.delivered).length;
  const totalClicked = recipients.filter((r) => r.clicked).length;
  const totalWechat = recipients.filter((r) => r.wechat).length;

  return {
    scope: { repId, lookbackDays },
    totals: {
      delivered: totalDelivered,
      clicked: totalClicked,
      wechat: totalWechat,
      overallCtr: totalDelivered > 0 ? totalClicked / totalDelivered : 0,
      overallPostClick: totalClicked > 0 ? totalWechat / totalClicked : 0,
    },
    dimensions,
  };
}

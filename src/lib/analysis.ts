// Adaptive rate analysis across multiple dimensions.
//
// Computes reply-rate and wechat-rate per bucket per dimension, picks
// dimensions where the data has enough signal to be honest about, and
// hides low-N buckets so empty cells don't look like real findings.
//
// Pure data layer — no UI. Consumed by /api/analysis (dashboard) and
// /lib/patterns (insight mining for helper memory).

import { supabase } from "@/lib/db";
import { CONTACTED_LEAD_STATUSES } from "@/lib/status";

// ── Types ──────────────────────────────────────────────────────────────

export interface LeadRow {
  id: string;
  status: string;
  author_email: string | null;
  matched_directions: string | string[] | null;
  compute_level: string | null;
  compute_confidence: number | null;
  school_tier: number | null;
  school_name: string | null;
  h_index: number | null;
  citation_count: number | null;
  industry_orgs: string[] | null;
  local_score: number | null;
  lead_tier: string | null;
  published_at: string | null;
  sent_at: string | null;
  assigned_rep_id: number | null;
  source: string | null;
}

export interface BucketStats {
  bucket: string;
  /** Population of this bucket (all leads, not just sent). */
  population: number;
  /** Sent = leads in CONTACTED_LEAD_STATUSES. */
  sent: number;
  /** Replied = leads currently in 'replied' status. */
  replied: number;
  /** WeChat = leads where a brief_lookups row marked added_wechat=true. */
  wechat: number;
  /** Replied / sent. NaN if sent=0. */
  replyRate: number;
  /** WeChat / sent. NaN if sent=0. */
  wechatRate: number;
  /** True if sent < MIN_BUCKET_N (rates not meaningful). */
  lowN: boolean;
}

export interface DimensionBreakdown {
  dimension: string;
  label: string;
  /** Coverage: fraction of leads that have a non-null value for this dim. */
  coverage: number;
  /** Total population (all leads in the scope). */
  population: number;
  /** Total sent in the scope. */
  totalSent: number;
  /** Buckets, ordered by sent desc by default. */
  buckets: BucketStats[];
  /** Lift = max(wechatRate) / baseline_wechatRate. Null if can't compute. */
  maxWechatLift: number | null;
  /** Same for reply. */
  maxReplyLift: number | null;
  /** True when this dimension has at least one bucket worth showing. */
  hasSignal: boolean;
}

export interface AnalysisScope {
  /** If set, restrict to leads assigned to this rep. */
  repId?: number | null;
  /** Lookback window in days; null = all-time. */
  lookbackDays?: number | null;
}

// ── Tunables ───────────────────────────────────────────────────────────

/** Minimum sent-count per bucket for the rate to be considered meaningful. */
const MIN_BUCKET_N = 10;
/** Minimum coverage (fraction non-null) for a dimension to render. */
const MIN_COVERAGE = 0.4;
/** Minimum buckets a dimension must have above MIN_BUCKET_N to render. */
const MIN_VALID_BUCKETS = 2;

// ── Loaders ────────────────────────────────────────────────────────────

export async function loadLeadsForAnalysis(scope: AnalysisScope): Promise<LeadRow[]> {
  let q = supabase.from("pipeline_leads").select(
    "id, status, author_email, matched_directions, compute_level, compute_confidence, school_tier, school_name, h_index, citation_count, industry_orgs, local_score, lead_tier, published_at, sent_at, assigned_rep_id, source"
  );
  if (scope.repId) q = q.eq("assigned_rep_id", scope.repId);
  if (scope.lookbackDays) {
    const cutoff = new Date(Date.now() - scope.lookbackDays * 86_400_000).toISOString();
    q = q.gte("created_at", cutoff);
  }
  const { data, error } = await q;
  if (error) {
    console.error("loadLeadsForAnalysis failed:", error.message);
    return [];
  }
  return (data ?? []) as LeadRow[];
}

/** Load WeChat-marked emails for the scope, return as a Set of lead_ids. */
export async function loadWechatLeadIds(repId: number | null | undefined): Promise<Set<string>> {
  let q = supabase
    .from("brief_lookups")
    .select("lead_id")
    .eq("added_wechat", true)
    .not("lead_id", "is", null);
  // Per-rep scoping = "marks this rep made", consistent with /api/metrics/me.
  if (repId) q = q.eq("marked_by_rep_id", repId);
  const { data, error } = await q;
  if (error) return new Set();
  const ids = new Set<string>();
  for (const r of data ?? []) {
    if (r.lead_id) ids.add(r.lead_id as string);
  }
  return ids;
}

// ── Bucketers ──────────────────────────────────────────────────────────

/** Email-domain → location code. Same heuristic as the smoke-test snapshot. */
export function locationFromEmail(email: string | null): string {
  if (!email || !email.includes("@")) return "unknown";
  const domain = email.split("@")[1].toLowerCase();
  if (domain.endsWith(".cn")) return "CN";
  if (domain.endsWith(".hk")) return "HK";
  if (domain.endsWith(".tw")) return "TW";
  if (domain.endsWith(".sg")) return "SG";
  if (domain.endsWith(".jp")) return "JP";
  if (domain.endsWith(".kr")) return "KR";
  if (domain.endsWith(".uk")) return "UK";
  if (domain.endsWith(".de")) return "DE";
  if (domain.endsWith(".ca")) return "CA";
  if (domain.endsWith(".au")) return "AU";
  if (domain.endsWith(".edu")) return "US (.edu)";
  return "other";
}

/** Pick the FIRST direction listed.
 *  matched_directions has THREE storage shapes in the wild:
 *    - real JS array  ["A", "B"]
 *    - comma-joined string  "A, B"
 *    - JSON-stringified array  '["A", "B"]'  ← from older Python imports
 *  Normalize all three to the first element. */
export function primaryDirection(md: string | string[] | null): string | null {
  if (!md) return null;
  if (Array.isArray(md)) return md[0] ?? null;
  const trimmed = md.trim();
  if (trimmed.startsWith("[")) {
    // JSON-stringified array. Parse defensively — bad JSON → fall through.
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0) return String(parsed[0]);
    } catch {
      // not valid JSON; treat as a comma string
    }
  }
  const first = trimmed.split(",")[0].trim();
  return first || null;
}

/** Bucket local_score into deciles. */
export function scoreBucket(score: number | null): string | null {
  if (score === null || score === undefined || Number.isNaN(score)) return null;
  if (score >= 1) return "0.9-1.0";
  const d = Math.floor(score * 10) / 10;
  const next = (d + 0.1).toFixed(1);
  return `${d.toFixed(1)}-${next}`;
}

/** Bucket h-index into useful tiers. */
export function hIndexBucket(h: number | null): string | null {
  if (h === null || h === undefined) return null;
  if (h < 5) return "0-4";
  if (h < 10) return "5-9";
  if (h < 20) return "10-19";
  if (h < 40) return "20-39";
  if (h < 70) return "40-69";
  return "70+";
}

/** Days since paper was published. */
export function paperAgeBucket(publishedAt: string | null): string | null {
  if (!publishedAt) return null;
  const days = (Date.now() - new Date(publishedAt).getTime()) / 86_400_000;
  if (days < 0) return "future"; // bad data — keep visible so it shows up
  if (days < 7) return "<1 week";
  if (days < 30) return "1-4 weeks";
  if (days < 90) return "1-3 months";
  if (days < 180) return "3-6 months";
  if (days < 365) return "6-12 months";
  return "1+ year";
}

/** Boolean: has industry_orgs set. */
export function industryBucket(orgs: string[] | null): string {
  return orgs && orgs.length > 0 ? "industry-affiliated" : "academic-only";
}

// ── Per-dimension breakdowns ───────────────────────────────────────────

interface DimensionDef {
  key: string;
  label: string;
  /** Map a lead → bucket label, or null to exclude it. */
  bucketer: (lead: LeadRow) => string | null;
  /** Optional bucket-name → display-order index. Non-listed buckets sort by sent desc. */
  bucketOrder?: Record<string, number>;
}

const DIMENSIONS: DimensionDef[] = [
  {
    key: "direction",
    label: "Research direction",
    bucketer: (l) => primaryDirection(l.matched_directions),
  },
  {
    key: "location",
    label: "Author location (email TLD)",
    bucketer: (l) => locationFromEmail(l.author_email),
  },
  {
    key: "compute_level",
    label: "Compute need",
    bucketer: (l) => l.compute_level,
    bucketOrder: { high: 0, moderate: 1, low: 2, unknown: 3 },
  },
  {
    key: "lead_tier",
    label: "Lead tier",
    bucketer: (l) => l.lead_tier,
    bucketOrder: { strong: 0, normal: 1 },
  },
  {
    key: "score_decile",
    label: "Local score (predicted)",
    bucketer: (l) => scoreBucket(l.local_score),
  },
  {
    key: "h_index",
    label: "Author h-index",
    bucketer: (l) => hIndexBucket(l.h_index),
    bucketOrder: { "0-4": 0, "5-9": 1, "10-19": 2, "20-39": 3, "40-69": 4, "70+": 5 },
  },
  {
    key: "school_tier",
    label: "School tier",
    bucketer: (l) => (l.school_tier === null || l.school_tier === undefined ? null : `tier ${l.school_tier}`),
    bucketOrder: { "tier 1": 0, "tier 2": 1, "tier 3": 2, "tier 4": 3, "tier 5": 4 },
  },
  {
    key: "industry",
    label: "Industry affiliation",
    bucketer: (l) => industryBucket(l.industry_orgs),
    bucketOrder: { "industry-affiliated": 0, "academic-only": 1 },
  },
  {
    key: "paper_age",
    label: "Paper age (at lead creation)",
    bucketer: (l) => paperAgeBucket(l.published_at),
    bucketOrder: { "<1 week": 0, "1-4 weeks": 1, "1-3 months": 2, "3-6 months": 3, "6-12 months": 4, "1+ year": 5, "future": 6 },
  },
  {
    key: "source",
    label: "Discovery source",
    bucketer: (l) => l.source ?? "arxiv",
  },
];

function computeBuckets(
  leads: LeadRow[],
  dim: DimensionDef,
  wechatLeadIds: Set<string>,
): { buckets: BucketStats[]; coverage: number } {
  const groups = new Map<string, LeadRow[]>();
  let withValue = 0;
  for (const l of leads) {
    const b = dim.bucketer(l);
    if (b === null || b === "" || b === "unknown") continue;
    withValue++;
    const arr = groups.get(b) ?? [];
    arr.push(l);
    groups.set(b, arr);
  }

  const buckets: BucketStats[] = [];
  const contactedSet = new Set<string>(CONTACTED_LEAD_STATUSES);
  for (const [name, rows] of groups) {
    let sent = 0;
    let replied = 0;
    let wechat = 0;
    for (const r of rows) {
      if (contactedSet.has(r.status)) sent++;
      if (r.status === "replied") replied++;
      if (wechatLeadIds.has(r.id)) wechat++;
    }
    buckets.push({
      bucket: name,
      population: rows.length,
      sent,
      replied,
      wechat,
      replyRate: sent > 0 ? replied / sent : NaN,
      wechatRate: sent > 0 ? wechat / sent : NaN,
      lowN: sent < MIN_BUCKET_N,
    });
  }

  // Sort: explicit order first, then by sent desc.
  buckets.sort((a, b) => {
    if (dim.bucketOrder) {
      const ai = dim.bucketOrder[a.bucket];
      const bi = dim.bucketOrder[b.bucket];
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
    }
    return b.sent - a.sent;
  });

  return {
    buckets,
    coverage: leads.length > 0 ? withValue / leads.length : 0,
  };
}

export interface AnalysisResult {
  scope: AnalysisScope;
  population: number;
  totalSent: number;
  totalReplied: number;
  totalWechat: number;
  baselineReplyRate: number;
  baselineWechatRate: number;
  dimensions: DimensionBreakdown[];
}

export async function runAnalysis(scope: AnalysisScope): Promise<AnalysisResult> {
  const [leads, wechatLeadIds] = await Promise.all([
    loadLeadsForAnalysis(scope),
    loadWechatLeadIds(scope.repId ?? null),
  ]);

  const contactedSet = new Set<string>(CONTACTED_LEAD_STATUSES);
  let totalSent = 0;
  let totalReplied = 0;
  let totalWechat = 0;
  for (const l of leads) {
    if (contactedSet.has(l.status)) totalSent++;
    if (l.status === "replied") totalReplied++;
    if (wechatLeadIds.has(l.id)) totalWechat++;
  }

  const baselineReplyRate = totalSent > 0 ? totalReplied / totalSent : 0;
  const baselineWechatRate = totalSent > 0 ? totalWechat / totalSent : 0;

  const dimensions: DimensionBreakdown[] = [];
  for (const dim of DIMENSIONS) {
    const { buckets, coverage } = computeBuckets(leads, dim, wechatLeadIds);
    const validBuckets = buckets.filter((b) => !b.lowN);
    const hasSignal =
      coverage >= MIN_COVERAGE &&
      validBuckets.length >= MIN_VALID_BUCKETS &&
      totalSent > 0;

    let maxWechatLift: number | null = null;
    let maxReplyLift: number | null = null;
    if (validBuckets.length > 0 && baselineWechatRate > 0) {
      const top = Math.max(...validBuckets.map((b) => b.wechatRate || 0));
      maxWechatLift = top / baselineWechatRate;
    }
    if (validBuckets.length > 0 && baselineReplyRate > 0) {
      const top = Math.max(...validBuckets.map((b) => b.replyRate || 0));
      maxReplyLift = top / baselineReplyRate;
    }

    dimensions.push({
      dimension: dim.key,
      label: dim.label,
      coverage,
      population: leads.length,
      totalSent,
      buckets,
      maxWechatLift,
      maxReplyLift,
      hasSignal,
    });
  }

  // Order: dimensions with strongest lift first, then by hasSignal, then alphabetic.
  dimensions.sort((a, b) => {
    if (a.hasSignal !== b.hasSignal) return a.hasSignal ? -1 : 1;
    const al = a.maxWechatLift ?? 0;
    const bl = b.maxWechatLift ?? 0;
    if (al !== bl) return bl - al;
    return a.label.localeCompare(b.label);
  });

  return {
    scope,
    population: leads.length,
    totalSent,
    totalReplied,
    totalWechat,
    baselineReplyRate,
    baselineWechatRate,
    dimensions,
  };
}

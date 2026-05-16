export interface Lead {
  id: string;
  arxivId: string;
  title: string;
  abstract: string | null;
  authors: string | null;
  pdfUrl: string | null;
  publishedAt: string | null;
  authorName: string | null;
  authorEmail: string;
  firstName: string | null;
  schoolName: string | null;
  schoolTier: number | null;
  computeLevel: string | null;
  computeConfidence: number | null;
  computeReason: string | null;
  matchedDirections: string | null;
  draftSubject: string | null;
  draftHtml: string | null;
  status: string;
  createdAt: string;
  sentAt: string | null;
  hIndex: number | null;
  citationCount: number | null;
  paperCount: number | null;
  leadTier: string | null;
  localScore: number | null;
  assignedRepId: number | null;
  s2AuthorId: string | null;
  threadId: string | null;
  industryOrgs?: string[] | null;
  // Multi-click interest signal (mig 078). Bumped on every
  // email.clicked webhook. > 1 = recipient came back to the email.
  clickCount?: number | null;
  lastClickAt?: string | null;
  // Hugging Face handle (first entry of persons.hf_users for the lead's
  // linked person). Surfaced as a clickable pill on LeadRow when set.
  // Coverage is sparse today (only 7 of 4380 persons populated as of
  // 2026-05-16) — broader person-side HF extraction is tracked as a
  // separate plan (S2 homepage + GitHub commit-author lookup).
  hfUser?: string | null;
}

export interface Rep {
  id: number;
  name: string;
  sender_email: string;
  sender_name: string;
  wechat_id: string;
  active: boolean;
}

export interface SourceRepAllocation {
  repId: number | null;
  repName: string;
  count: number;
}

export interface SourceRow {
  source: string;
  /**
   * Count of raw rows in `discovery_leads` for this source. Always 0
   * for arXiv (which writes directly into pipeline_leads). Surfaces
   * the top-of-funnel from the Python scrapers before they're promoted.
   */
  discovered: number;
  total: number;
  strong: number;
  normal: number;
  sent: number;
  replied: number;
  wechat: number;
  convRate: number;
  reps: SourceRepAllocation[];
}

/**
 * Row shape for the `discovery_leads` table (multi-source scout
 * pipeline written by the Python scrapers).
 *
 * `source` is a short code: 'hf' | 'ph' | 'github'. Use
 * SOURCE_LABELS in `@/lib/sources` to render.
 */
export interface DiscoveryLead {
  id: number;
  source: string;
  externalId: string;
  score: number;
  signals: Record<string, unknown>;
  profileUrl: string | null;
  fullname: string | null;
  location: string | null;
  org: string | null;
  bio: string | null;
  contactHint: string | null;
  email: string | null;
  promotedAt: string | null;
  firstSeen: string;
  lastSeen: string;
  hitCount: number;
}

export interface TierRow {
  tier: string;
  assigned: number;
  sent: number;
  replied: number;
  wechat: number;
  convRate: number;
}

export interface CategoryRow {
  name: string;
  assigned: number;
  sent: number;
  wechat: number;
  convRate: number;
}

export interface RepStats {
  rep: {
    id: number;
    name: string;
    sender_email: string;
    wechat_id: string;
    active: boolean;
  };
  assigned: number;
  sent: number;
  replied: number;
  wechat: number;
  convRate: number;
  tiers: TierRow[];
  categories: CategoryRow[];
}

export interface HIndexBucket {
  min: number;
  max: number | null;
  count: number;
}

export interface DailyBucket {
  date: string;
  strong: number;
  normal: number;
}

export interface Analytics {
  channels: {
    totalLeads: number;
    strongLeads: number;
    leadsThisWeek: number;
    avgHIndex: number;
    sentLeads: number;
    wechatCount: number;
    conversionRate: number;
    daily: DailyBucket[];
    hIndexDist: HIndexBucket[];
    sources: SourceRow[];
  };
  sales: { reps: RepStats[] };
}

export interface SendCheck {
  ok: boolean;
  reason?: string;
  availableIn?: string;
}

const SEND_MIN_AGE_MS = 7 * 86_400_000;

// Anchored on `createdAt` to match the canonical `isAgeGated` /
// `isReadyToSend` helpers in src/lib/policy.ts. Earlier this used
// `publishedAt`, which produced a different "ripening" set than the
// server-side ready-count endpoint and the batch-send banner — see
// the 2026-05-09 smoke (#26: three-way ready-count mismatch).
export function canSend(lead: Lead): SendCheck {
  if (lead.status !== "ready") return { ok: false, reason: "Not ready" };
  if (!lead.draftHtml) return { ok: false, reason: "No draft" };
  if (!lead.createdAt) return { ok: true };

  const created = new Date(lead.createdAt);
  const ageMs = Date.now() - created.getTime();
  if (ageMs < SEND_MIN_AGE_MS) {
    const remainingMs = SEND_MIN_AGE_MS - ageMs;
    const daysLeft = Math.ceil(remainingMs / 86_400_000);
    const label = daysLeft >= 1 ? `${daysLeft}d` : `${Math.ceil(remainingMs / 3_600_000)}h`;
    return { ok: false, reason: "Too new", availableIn: label };
  }
  return { ok: true };
}

export function tierBadgeClass(tier: string | null) {
  return `badge-tier ${tier === "strong" ? "strong" : "normal"}`;
}

export function computeBadgeClass(level: string | null) {
  return `badge-compute ${level && level !== "none" ? level : ""}`;
}

export function statusBadgeClass(status: string) {
  return `badge-status ${status}`;
}

export function shortDate(dateStr: string | null) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function paperAge(dateStr: string | null): { text: string; color: string } {
  if (!dateStr) return { text: "", color: "" };
  const pub = new Date(dateStr);
  const diffMs = Date.now() - pub.getTime();
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffHours < 0) return { text: "future?", color: "text-red-400" };
  if (diffHours < 24) return { text: `${diffHours}h ago · too new`, color: "text-amber-400" };
  if (diffDays === 1) return { text: "1 day ago", color: "text-green-400" };
  if (diffDays <= 3) return { text: `${diffDays}d ago`, color: "text-green-400" };
  if (diffDays <= 7) return { text: `${diffDays}d ago`, color: "text-[var(--text-secondary)]" };
  if (diffDays <= 14) return { text: `${diffDays}d ago`, color: "text-[var(--text-tertiary)]" };
  return { text: `${diffDays}d ago`, color: "text-[var(--text-tertiary)]" };
}

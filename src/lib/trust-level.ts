/**
 * Training-wheels capability resolver.
 *
 * Given a rep, returns what they're allowed to do today:
 *   - canBulkSend: gate on /api/pipeline/batch-send (enforced)
 *   - bulkBatchMax: per-batch limit (enforced in batch-send)
 *   - dailyLeadCap: TARGET — observational, not enforced. The codebase's
 *     routing is deterministic per-paper, so there's no spillover model.
 *     Surfaced for admin awareness ("Yujie's queue should be ~10/day").
 *     The real throttle is dailySendCap.
 *   - dailySendCap: max sends-per-day across single + batch combined
 *     (enforced in both /api/pipeline/send and /batch-send).
 *   - reason: human-readable explanation (rendered on /pipeline UI).
 *
 * The capability function combines two signals:
 *   1. trust_level (admin-set, default 0): admin override knob
 *   2. total sends to date (computed from emails.actor_rep_id): tenure
 *
 * Admin can pin a rep to any capability tier by setting trust_level
 * directly. Without admin intervention, reps progress through tiers
 * automatically as they accumulate sends.
 *
 * NOTE: this is intentionally conservative for early-tenure reps. The
 * bench has not validated draft-quality-based auto-send (we have
 * compute_confidence and local_score, but neither is a measure of how
 * good the GENERATED EMAIL is — only of how good the LEAD is). Until
 * draft-quality is validated, no auto-send tier exists.
 */
import { supabase } from "@/lib/db";

export interface RepCapabilities {
  repId: number;
  canBulkSend: boolean;
  bulkBatchMax: number;       // 1 means "no bulk" (single-send only)
  dailyLeadCap: number | null; // null = uncapped (admin / senior / mature rep)
  dailySendCap: number | null; // null = uncapped
  totalSends: number;
  trustLevel: number;
  tenureDays: number;
  tier: TrustTier;
  reason: string;             // shown to the rep on /pipeline
}

export type TrustTier =
  | "restricted"   // trust_level < 0 — admin pinned them down
  | "novice"       // 0 sends, fresh onboard
  | "training"     // 1-29 sends OR tenure < 7 days
  | "intermediate" // 30-99 sends — bulk unlocks
  | "mature"       // 100+ sends — uncapped
  | "admin";       // admin / senior — no gates

/**
 * Tier rules. Edit thresholds here, callers re-derive automatically.
 *
 * The thresholds are guesses informed by the existing data: ~211 sends
 * total by rep_id=2 over a month, so 30 / 100 splits "first week" /
 * "first month" / "experienced". Adjust after we have real reply-rate
 * data per tier.
 */
const TIERS: Record<TrustTier, Omit<RepCapabilities, "repId" | "totalSends" | "trustLevel" | "tenureDays" | "tier" | "reason">> = {
  restricted:   { canBulkSend: false, bulkBatchMax: 1,   dailyLeadCap: 3,    dailySendCap: 3 },
  novice:       { canBulkSend: false, bulkBatchMax: 1,   dailyLeadCap: 5,    dailySendCap: 5 },
  training:     { canBulkSend: false, bulkBatchMax: 1,   dailyLeadCap: 10,   dailySendCap: 15 },
  intermediate: { canBulkSend: true,  bulkBatchMax: 5,   dailyLeadCap: 25,   dailySendCap: 40 },
  // Both mature + admin now allow up to 200 per batch (Vercel Pro 300s
  // function cap, ~1.2s per send). Bumped 2026-05-14 — reps were
  // getting 'Max 50 per batch' errors mid-quota with the 50/day per-rep
  // quotas now in place.
  mature:       { canBulkSend: true,  bulkBatchMax: 200, dailyLeadCap: null, dailySendCap: null },
  admin:        { canBulkSend: true,  bulkBatchMax: 200, dailyLeadCap: null, dailySendCap: null },
};

/**
 * Single source of truth for "what tier is this rep?".
 * Pure function — easy to unit test.
 *
 * trust_level semantics:
 *   -1 → restricted (admin pin)
 *    0 → default; tier derived from totalSends + tenure
 *    1 → intermediate (admin pin)
 *    2 → mature (admin pin)
 * Values >= 2 all collapse to mature; the API rejects > 2 to make this
 * explicit (prevents "I set trust_level=5 expecting admin-tier" footgun).
 *
 * NOTE: role=admin / role=senior wins over trust_level. Even setting
 * trust_level=-1 on an admin row leaves them in admin tier (we don't
 * want accidental self-lockouts to brick the admin UI). If you need to
 * truly demote an admin, change their role.
 */
export function classifyTier(input: {
  role: string;
  trustLevel: number;
  totalSends: number;
  tenureDays: number;
}): TrustTier {
  const { role, trustLevel, totalSends, tenureDays } = input;
  if (role === "admin" || role === "senior") return "admin";
  if (trustLevel < 0) return "restricted";
  if (trustLevel >= 2) return "mature";       // admin override → mature
  if (trustLevel >= 1) return "intermediate"; // admin override → intermediate
  if (totalSends >= 100) return "mature";
  if (totalSends >= 30) return "intermediate";
  if (totalSends === 0 && tenureDays < 1) return "novice";
  return "training";
}

/** How many emails this rep has actually sent (actor, not assigned).
 *  Per CLAUDE.md attribution rules, actor_rep_id is the source of
 *  truth for "who performed the send". */
export async function totalSendsByRep(repId: number): Promise<number> {
  const { count } = await supabase
    .from("emails")
    .select("id", { count: "exact", head: true })
    .eq("actor_rep_id", repId);
  return count ?? 0;
}

/** Live count of sends today by this rep. Exported for the batch-send
 *  per-iteration race-mitigation re-check (override-quota uses the same
 *  pattern via countOverridesTodayByRep). */
export async function sendsTodayByRep(repId: number): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { count } = await supabase
    .from("emails")
    .select("id", { count: "exact", head: true })
    .eq("actor_rep_id", repId)
    .gte("created_at", todayStart.toISOString());
  return count ?? 0;
}

export async function getCapabilities(repId: number): Promise<RepCapabilities> {
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role, trust_level, onboarded_at, trust_notes")
    .eq("id", repId)
    .maybeSingle();
  if (!rep) {
    // Caller's job to handle "rep doesn't exist" before calling us; if
    // we get here something is structurally wrong. Default to the most
    // restrictive non-restricted tier.
    return composeCapabilities(repId, "novice", 0, 0, 0, "rep not found, defaulting to novice");
  }
  const totalSends = await totalSendsByRep(repId);
  // Guard against NaN/negative tenure: bad timestamps in DB or clock skew.
  // We treat any non-finite or negative value as "day-zero" (0). A value
  // of NaN bubbling into classifyTier silently mis-classifies (every NaN
  // comparison is false) AND surfaces "NaN days" in the UI reason string.
  let tenureDays = 0;
  if (rep.onboarded_at) {
    const ms = Date.now() - new Date(rep.onboarded_at).getTime();
    if (Number.isFinite(ms) && ms >= 0) tenureDays = ms / 86400000;
  }
  const tier = classifyTier({
    role: rep.role,
    trustLevel: rep.trust_level,
    totalSends,
    tenureDays,
  });
  const reason = explainTier(tier, totalSends, tenureDays, rep.trust_level, rep.trust_notes);
  return composeCapabilities(repId, tier, totalSends, rep.trust_level, tenureDays, reason);
}

function composeCapabilities(
  repId: number,
  tier: TrustTier,
  totalSends: number,
  trustLevel: number,
  tenureDays: number,
  reason: string,
): RepCapabilities {
  const t = TIERS[tier];
  return {
    repId,
    canBulkSend: t.canBulkSend,
    bulkBatchMax: t.bulkBatchMax,
    dailyLeadCap: t.dailyLeadCap,
    dailySendCap: t.dailySendCap,
    totalSends,
    trustLevel,
    tenureDays: Math.floor(tenureDays * 10) / 10,
    tier,
    reason,
  };
}

function explainTier(
  tier: TrustTier,
  totalSends: number,
  tenureDays: number,
  trustLevel: number,
  trustNotes: string | null,
): string {
  const tail = trustNotes ? ` (admin note: ${trustNotes})` : "";
  switch (tier) {
    case "admin":
      return "admin/senior — no send caps." + tail;
    case "restricted":
      return `restricted by admin (trust_level=${trustLevel})` + tail;
    case "novice":
      return `new rep, ${tenureDays.toFixed(1)} days in. Bulk unlocks at 30 manual sends.` + tail;
    case "training":
      return `training wheels (${totalSends}/30 sends until bulk unlocks).` + tail;
    case "intermediate":
      return `bulk send up to 5/batch (${totalSends}/100 sends until uncapped).` + tail;
    case "mature":
      return `experienced — uncapped.` + tail;
  }
}

/**
 * Helper — checks whether a proposed batch size is permitted.
 * Returns null on success or an error string for the caller to pass through.
 */
export async function checkBulkSendAllowed(
  repId: number,
  batchSize: number,
): Promise<{ ok: true; capabilities: RepCapabilities } | { ok: false; reason: string; capabilities: RepCapabilities }> {
  const caps = await getCapabilities(repId);
  if (!caps.canBulkSend) {
    return {
      ok: false,
      reason:
        `Bulk send is not unlocked yet. ${caps.reason} ` +
        "Use single-send (one lead at a time) until the bulk gate opens.",
      capabilities: caps,
    };
  }
  if (batchSize > caps.bulkBatchMax) {
    return {
      ok: false,
      reason:
        `Your tier (${caps.tier}) allows max ${caps.bulkBatchMax} per batch. ` +
        `You tried ${batchSize}. Split into smaller batches or ask admin to bump trust_level.`,
      capabilities: caps,
    };
  }
  // Daily send cap (combined single+batch).
  if (caps.dailySendCap !== null) {
    const sentToday = await sendsTodayByRep(repId);
    const wouldExceed = sentToday + batchSize > caps.dailySendCap;
    if (wouldExceed) {
      return {
        ok: false,
        reason:
          `Daily send cap reached (${sentToday}/${caps.dailySendCap}). ` +
          "Comes back tomorrow, or ask admin to bump trust_level.",
        capabilities: caps,
      };
    }
  }
  return { ok: true, capabilities: caps };
}

/** Same shape as checkBulkSendAllowed but for a single send. */
export async function checkSingleSendAllowed(
  repId: number,
): Promise<{ ok: true; capabilities: RepCapabilities } | { ok: false; reason: string; capabilities: RepCapabilities }> {
  const caps = await getCapabilities(repId);
  if (caps.dailySendCap !== null) {
    const sentToday = await sendsTodayByRep(repId);
    if (sentToday >= caps.dailySendCap) {
      return {
        ok: false,
        reason:
          `Daily send cap reached (${sentToday}/${caps.dailySendCap}). ` +
          "Comes back tomorrow, or ask admin to bump trust_level.",
        capabilities: caps,
      };
    }
  }
  return { ok: true, capabilities: caps };
}

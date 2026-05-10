/**
 * Lead-send policy helpers.
 *
 * The 7-day age gate prevents us from emailing authors immediately after a
 * lead lands in the funnel — it gives papers time to settle and reduces the
 * "spammy first responder" feel. Both the single send and batch send routes
 * enforce this server-side; the pipeline UI surfaces an `Override` toggle
 * per-lead when the operator wants to bypass.
 *
 * `created_at` is the canonical anchor (i.e. when the row entered our
 * pipeline), not `published_at`. This matches the spec for Feature 2.
 */

export const MIN_AGE_DAYS = 7;
export const MIN_AGE_MS = MIN_AGE_DAYS * 86_400_000;

export function leadAgeDays(createdAt: string | Date): number {
  const t = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  return (Date.now() - t.getTime()) / 86_400_000;
}

export function isAgeGated(createdAt: string | Date): boolean {
  return leadAgeDays(createdAt) < MIN_AGE_DAYS;
}

/**
 * Canonical "is this lead a ripening candidate" check — duplicated across
 * the pipeline page (header stat, status chip, banner) and the sidebar
 * badge. Anchored on `created_at` to match the server-side ready-count
 * endpoint (`/api/pipeline/ready-count`). Previously the page used
 * `published_at` while the server used `created_at`, producing the
 * three-way mismatch the 2026-05-09 smoke flagged.
 *
 * "Ripening" = status='ready' AND created_at <= 7d ago (still in the
 * cooldown window). Use `isReadyToSend` for the inverse — what sales
 * can actually act on now.
 */
export function isRipeningLead(lead: { status: string; createdAt: string | Date }): boolean {
  return lead.status === "ready" && isAgeGated(lead.createdAt);
}

/**
 * Canonical "this lead is ready and sendable now" — the single source of
 * truth for the pipeline page's READY count, the sidebar badge, the
 * status filter chip, and the batch-send banner. status='ready' AND
 * past the 7-day cooldown.
 */
export function isReadyToSend(lead: { status: string; createdAt: string | Date }): boolean {
  return lead.status === "ready" && !isAgeGated(lead.createdAt);
}

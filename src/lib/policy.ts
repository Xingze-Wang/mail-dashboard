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

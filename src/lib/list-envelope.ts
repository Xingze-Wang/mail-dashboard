/**
 * Standard "this query was capped" envelope.
 *
 * Tier 1 of the data-integrity plan (docs/DATA_INTEGRITY_PLAN.md): every
 * list/aggregate API response that paginates or applies a row cap MUST
 * say so on the wire, and the UI MUST be able to detect it. Without
 * this, a query hitting a 200-row cap would return partial results and
 * the dashboard would render them as truth — which is exactly how we
 * shipped "281 sent" when reality was 1382.
 *
 * Two mechanical fields:
 *
 *   - `truncated`: true when the response is a strict subset of what
 *     the query would have returned without our cap. Always include
 *     when there is a row cap, even if the cap was not hit on this
 *     request — false is a valid, informative value.
 *   - `_source`: which datastore answered. The plan calls this out
 *     because we have at least three plausible sources for some
 *     endpoints (Resend live API, our `emails` cache, the daily cron
 *     snapshot). When two endpoints disagree, `_source` is what tells
 *     the on-call rep which one they're looking at.
 *
 * Optional but encouraged:
 *
 *   - `scannedTotal`: how many rows the cap saw before slicing.
 *   - `requestedTotal`: the unbounded count, when cheap (e.g.
 *     `select head=true` was ~free anyway).
 *
 * Keep this tiny. It is a wire contract, not a class hierarchy.
 */

export interface ListEnvelope {
  truncated: boolean;
  scannedTotal?: number;
  requestedTotal?: number;
  _source: string;
}

export function listEnvelope(opts: {
  scannedTotal?: number;
  requestedTotal?: number;
  cap?: number;
  source: string;
}): ListEnvelope {
  const { scannedTotal, requestedTotal, cap, source } = opts;
  // Determine truncation honestly. If we know both scanned and the cap,
  // truncated when scanned >= cap (the cap was hit). If we know
  // requestedTotal and scannedTotal, truncated when scannedTotal <
  // requestedTotal. Otherwise default to false — better to be wrong on
  // the safe side and let callers override.
  let truncated = false;
  if (typeof scannedTotal === "number" && typeof cap === "number") {
    truncated = scannedTotal >= cap;
  }
  if (
    typeof scannedTotal === "number" &&
    typeof requestedTotal === "number" &&
    scannedTotal < requestedTotal
  ) {
    truncated = true;
  }
  const env: ListEnvelope = { truncated, _source: source };
  if (typeof scannedTotal === "number") env.scannedTotal = scannedTotal;
  if (typeof requestedTotal === "number") env.requestedTotal = requestedTotal;
  return env;
}

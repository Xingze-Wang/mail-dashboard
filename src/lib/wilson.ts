/**
 * Wilson score interval — proportions with a binomial CI that
 * doesn't blow up at small n the way naïve normal-approximation
 * does, and doesn't go negative or > 1 the way some others do.
 *
 * z=1.96 → 95% CI. z=2.58 → 99%.
 *
 * Used by:
 *   - src/app/api/cron/template-auto-promote/route.ts (decision gate)
 *   - src/lib/congress-runners.ts (evidence-pack annotations so
 *     personas can't make 0%-conversion conclusions on n=5)
 *
 * Do NOT inline a copy elsewhere; bugs in the formula sneak in
 * easily (it's easy to drop the (z²/n) center term and accidentally
 * use the unstable Agresti-Coull form). One module, one bug surface.
 */

export function wilsonCI(clicked: number, sent: number, z = 1.96): [number, number] {
  if (sent === 0) return [0, 1];
  const p = clicked / sent;
  const denom = 1 + (z * z) / sent;
  const center = (p + (z * z) / (2 * sent)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / sent + (z * z) / (4 * sent * sent))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/**
 * Format a proportion + Wilson CI in a way that's readable inside
 * an LLM evidence pack. Goal: communicate uncertainty without
 * forcing the LLM to do its own statistics.
 *
 * Examples:
 *   formatRateWithCI(2, 50)
 *     → "4.0% [95% CI: 1.1%–13.5%, n=50]"
 *   formatRateWithCI(0, 5)
 *     → "0.0% [95% CI: 0.0%–43.4%, n=5 — too few to call]"
 *
 * The "too few to call" tag fires under MIN_RELIABLE_N (=20). It's
 * the prompt-side signal we use to stop personas from drawing strong
 * conclusions out of tiny samples.
 */
export function formatRateWithCI(numerator: number, denominator: number, opts?: { unit?: string }): string {
  const unit = opts?.unit ?? "%";
  if (denominator === 0) return `n/a (no data, n=0)`;
  const rate = numerator / denominator;
  const [lo, hi] = wilsonCI(numerator, denominator);
  const tag = denominator < MIN_RELIABLE_N ? " — too few to call" : "";
  return `${(rate * 100).toFixed(1)}${unit} [95% CI: ${(lo * 100).toFixed(1)}${unit}–${(hi * 100).toFixed(1)}${unit}, n=${denominator}${tag}]`;
}

/**
 * Threshold under which we explicitly tell consumers the sample is
 * unreliable. 20 is empirically chosen — it's the smallest n where
 * the Wilson interval at p=0 narrows enough that "0% conversion" stops
 * being the same statement as "we have no idea". Below 20 the CI
 * width swallows most reasonable hypotheses.
 */
export const MIN_RELIABLE_N = 20;

/**
 * Two-proportion comparison. Returns a verdict on whether the
 * difference between (a/an, b/bn) is statistically supportable at
 * 95% — i.e. whether their Wilson CIs are non-overlapping.
 *
 * Used by the adversary persona to determine whether "Fudan 0% vs
 * SJTU X%" is a real difference or a sample artifact.
 *
 * 'inconclusive' = CIs overlap (could be the same true rate). This
 * is the SAFE default — adversary only fires if the difference is
 * defensible.
 */
export function compareProportions(
  a: number, an: number,
  b: number, bn: number,
): { verdict: "a_higher" | "b_higher" | "inconclusive"; aCi: [number, number]; bCi: [number, number] } {
  const aCi = wilsonCI(a, an);
  const bCi = wilsonCI(b, bn);
  // Non-overlapping is sufficient for "different at 95%". This is
  // CONSERVATIVE — proper test (z-test on difference) would call
  // some borderline-overlap cases significant. Erring conservative
  // is fine for adversary signal: we only want to challenge when
  // we're confident.
  if (aCi[0] > bCi[1]) return { verdict: "a_higher", aCi, bCi };
  if (bCi[0] > aCi[1]) return { verdict: "b_higher", aCi, bCi };
  return { verdict: "inconclusive", aCi, bCi };
}

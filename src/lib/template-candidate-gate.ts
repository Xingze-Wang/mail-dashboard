/**
 * Pure helpers for the two-signal gate that decides if a per-rep
 * template should be surfaced as a candidate global template.
 *
 * Signal 1: actual clicks (Wilson 95% CI non-overlap)
 * Signal 2: predicted clicks (avg p_click ≥ N% lift)
 *
 * No DB access. Caller fetches the numbers and passes them in.
 */

export interface CountPair {
  clicked: number;
  sent: number;
}

export interface WilsonCI {
  lower: number;
  upper: number;
  point: number;
}

/**
 * Wilson score interval for a Bernoulli proportion.
 * α=0.95 → z=1.96 by default.
 */
export function wilsonInterval(clicked: number, sent: number, alpha = 0.95): WilsonCI {
  if (sent <= 0) return { lower: 0, upper: 0, point: 0 };
  // z for 95% two-sided
  const z = alpha === 0.95 ? 1.96 : alpha === 0.99 ? 2.576 : 1.96;
  const n = sent;
  const p = clicked / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const halfWidth = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
    point: p,
  };
}

export interface EvaluateCandidateInput {
  perRep: CountPair;
  global: CountPair;
  perRepPredicted: number; // avg p_click from model_predictions
  globalPredicted: number;
  predictedLiftRequired: number; // e.g. 1.1 = 10% relative lift
  alpha?: number; // CI alpha, default 0.95
}

export interface EvaluateCandidateResult {
  passes: boolean;
  actualSignalAgrees: boolean;
  predictedSignalAgrees: boolean;
  perRepCI: WilsonCI;
  globalCI: WilsonCI;
  perRepPredicted: number;
  globalPredicted: number;
  predictedLift: number;
  reason: string;
}

export function evaluateCandidate(input: EvaluateCandidateInput): EvaluateCandidateResult {
  const alpha = input.alpha ?? 0.95;
  const perRepCI = wilsonInterval(input.perRep.clicked, input.perRep.sent, alpha);
  const globalCI = wilsonInterval(input.global.clicked, input.global.sent, alpha);

  // Actual: per-rep lower bound exceeds global upper bound (Wilson non-overlap)
  const actualSignalAgrees = perRepCI.lower > globalCI.upper;

  // Predicted: per-rep avg ≥ global avg × predictedLiftRequired
  const predictedLift =
    input.globalPredicted > 0 ? input.perRepPredicted / input.globalPredicted : Infinity;
  const predictedSignalAgrees = predictedLift >= input.predictedLiftRequired;

  const passes = actualSignalAgrees && predictedSignalAgrees;

  const reason = passes
    ? `Both signals agree. Actual CI ${perRepCI.lower.toFixed(3)} > ${globalCI.upper.toFixed(3)} (global UB). Predicted lift ${predictedLift.toFixed(2)}× ≥ ${input.predictedLiftRequired}×.`
    : `${actualSignalAgrees ? "Actual ✓" : `Actual ✗ (CIs overlap: per-rep [${perRepCI.lower.toFixed(3)}, ${perRepCI.upper.toFixed(3)}], global [${globalCI.lower.toFixed(3)}, ${globalCI.upper.toFixed(3)}])`}; ${predictedSignalAgrees ? "Predicted ✓" : `Predicted ✗ (lift ${predictedLift.toFixed(2)}× < ${input.predictedLiftRequired}×)`}`;

  return {
    passes,
    actualSignalAgrees,
    predictedSignalAgrees,
    perRepCI,
    globalCI,
    perRepPredicted: input.perRepPredicted,
    globalPredicted: input.globalPredicted,
    predictedLift,
    reason,
  };
}

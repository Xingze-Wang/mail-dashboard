// Minimal logistic regression fit + predict. No matrix libs — n ~ 10^3,
// features ~ 10^1, fits in a few hundred gradient steps in plain JS under
// a Vercel serverless timeout. Uses L2 regularization + early stopping.
//
// Not a replacement for sklearn; good enough for showing admins which
// features move conversion and serving a P(add on wechat) number.

export interface LRModel {
  featureNames: string[];
  weights: number[];  // same length as featureNames
  intercept: number;
  // Fit stats for the dashboard
  nSamples: number;
  nPositive: number;
  auc: number;             // held-out AUC
  logLoss: number;         // held-out log-loss
  trainLogLoss: number;    // sanity check for overfit gap
  iterations: number;
}

export interface FitOptions {
  learningRate?: number;
  l2?: number;
  maxIter?: number;
  tolerance?: number;
  trainFrac?: number;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

function logLoss(X: number[][], y: number[], w: number[], b: number, l2: number): number {
  let sum = 0;
  for (let i = 0; i < X.length; i++) {
    let z = b;
    for (let j = 0; j < w.length; j++) z += w[j] * X[i][j];
    const p = sigmoid(z);
    // Clamp to avoid log(0)
    const pp = Math.max(1e-12, Math.min(1 - 1e-12, p));
    sum += y[i] * Math.log(pp) + (1 - y[i]) * Math.log(1 - pp);
  }
  const n = X.length;
  let reg = 0;
  for (const wj of w) reg += wj * wj;
  return -sum / n + (l2 / 2) * reg;
}

function rocAuc(predictions: number[], labels: number[]): number {
  // Mann–Whitney U formulation — stable for small samples.
  const pairs = predictions.map((p, i) => ({ p, y: labels[i] }));
  pairs.sort((a, b) => a.p - b.p);
  // Average rank for ties
  let i = 0;
  const ranks: number[] = new Array(pairs.length);
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1].p === pairs[i].p) j++;
    const avg = (i + j) / 2 + 1; // 1-indexed
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }
  const pos = pairs.filter((r) => r.y === 1).length;
  const neg = pairs.length - pos;
  if (pos === 0 || neg === 0) return 0.5;
  let sumRanksPos = 0;
  for (let k = 0; k < pairs.length; k++) if (pairs[k].y === 1) sumRanksPos += ranks[k];
  const u = sumRanksPos - (pos * (pos + 1)) / 2;
  return u / (pos * neg);
}

export function fitLR(
  X: number[][],
  y: number[],
  featureNames: string[],
  opts: FitOptions = {},
): LRModel {
  const {
    learningRate = 0.1,
    l2 = 0.01,
    maxIter = 500,
    tolerance = 1e-5,
    trainFrac = 0.8,
  } = opts;
  if (X.length === 0) throw new Error("No samples");
  if (X[0].length !== featureNames.length) throw new Error("featureNames length mismatch");

  // Train/test split (deterministic — stratify by label so held-out has both
  // classes when data is thin).
  const posIdx: number[] = [];
  const negIdx: number[] = [];
  for (let i = 0; i < y.length; i++) (y[i] === 1 ? posIdx : negIdx).push(i);

  function split(indices: number[]) {
    const cut = Math.max(1, Math.floor(indices.length * trainFrac));
    return { train: indices.slice(0, cut), test: indices.slice(cut) };
  }
  const { train: trPos, test: tePos } = split(posIdx);
  const { train: trNeg, test: teNeg } = split(negIdx);
  const trainIdx = trPos.concat(trNeg);
  const testIdx = tePos.concat(teNeg);

  const Xtr = trainIdx.map((i) => X[i]);
  const ytr = trainIdx.map((i) => y[i]);
  const Xte = testIdx.map((i) => X[i]);
  const yte = testIdx.map((i) => y[i]);

  const w = new Array(featureNames.length).fill(0);
  let b = 0;
  let prevLoss = Infinity;
  let iter = 0;
  for (iter = 0; iter < maxIter; iter++) {
    const gradW = new Array(w.length).fill(0);
    let gradB = 0;
    for (let i = 0; i < Xtr.length; i++) {
      let z = b;
      for (let j = 0; j < w.length; j++) z += w[j] * Xtr[i][j];
      const p = sigmoid(z);
      const err = p - ytr[i];
      gradB += err;
      for (let j = 0; j < w.length; j++) gradW[j] += err * Xtr[i][j];
    }
    const n = Xtr.length;
    for (let j = 0; j < w.length; j++) w[j] -= learningRate * (gradW[j] / n + l2 * w[j]);
    b -= learningRate * (gradB / n);

    if (iter % 25 === 0) {
      const ll = logLoss(Xtr, ytr, w, b, l2);
      if (Math.abs(prevLoss - ll) < tolerance) break;
      prevLoss = ll;
    }
  }

  // Evaluate on held-out.
  const teProbs = Xte.map((x) => {
    let z = b;
    for (let j = 0; j < w.length; j++) z += w[j] * x[j];
    return sigmoid(z);
  });
  const auc = Xte.length > 0 ? rocAuc(teProbs, yte) : 0.5;
  const teLoss = Xte.length > 0 ? logLoss(Xte, yte, w, b, 0) : 0;
  const trLoss = logLoss(Xtr, ytr, w, b, 0);

  return {
    featureNames,
    weights: w,
    intercept: b,
    nSamples: X.length,
    nPositive: posIdx.length,
    auc,
    logLoss: teLoss,
    trainLogLoss: trLoss,
    iterations: iter,
  };
}

export function predictLR(model: LRModel, x: number[]): number {
  if (x.length !== model.weights.length) throw new Error("feature vector length mismatch");
  let z = model.intercept;
  for (let j = 0; j < model.weights.length; j++) z += model.weights[j] * x[j];
  return sigmoid(z);
}

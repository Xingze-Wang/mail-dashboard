/**
 * Sanity-check Wilson CI against textbook reference values + a few
 * pathological edges. If these match published examples, the formula
 * is right.
 *
 * Reference values from Wilson 1927 + standard stats textbooks.
 */

function wilsonCI(clicked: number, sent: number, z = 1.96): [number, number] {
  if (sent === 0) return [0, 1];
  const p = clicked / sent;
  const denom = 1 + (z * z) / sent;
  const center = (p + (z * z) / (2 * sent)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / sent + (z * z) / (4 * sent * sent))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

const cases = [
  // (clicked, sent, label, expected_lower, expected_upper, tolerance)
  // Textbook: 50/100 ⇒ ~[40.4%, 59.6%]
  [50, 100, "50/100 (perfect-balance)", 0.404, 0.596, 0.01],
  // 0/30 (zero info on the click side, n small)
  // Wilson says ≈ [0, 11.6%]  (vs normal: ±0%, useless)
  [0, 30, "0/30 (extreme low)", 0, 0.116, 0.01],
  // 30/30 (extreme high) — symmetric to above
  [30, 30, "30/30 (extreme high)", 0.884, 1.0, 0.01],
  // 5/100 — small click rate, moderate n
  [5, 100, "5/100 (small p)", 0.022, 0.111, 0.01],
  // 100/1000 — same point estimate, tighter
  [100, 1000, "100/1000 (same p, larger n)", 0.0828, 0.1199, 0.01],
] as const;

console.log("Wilson 95% CI sanity check:\n");
let allPass = true;
for (const [clicked, sent, label, expLow, expHigh, tol] of cases) {
  const [low, high] = wilsonCI(clicked as number, sent as number);
  const lowOk = Math.abs(low - (expLow as number)) <= (tol as number);
  const highOk = Math.abs(high - (expHigh as number)) <= (tol as number);
  const ok = lowOk && highOk;
  if (!ok) allPass = false;
  console.log(
    `  ${ok ? "✅" : "❌"} ${label}: ` +
    `[${(low * 100).toFixed(1)}%, ${(high * 100).toFixed(1)}%] ` +
    `(expected ~[${((expLow as number) * 100).toFixed(1)}%, ${((expHigh as number) * 100).toFixed(1)}%])`,
  );
}

console.log("");

// Now test the actual decision rule used in template-auto-promote
console.log("Decision rule sanity check (promote when draft_lo > active_hi):\n");
const decisionCases = [
  {
    label: "noisy: 8/30 vs 6/30 — point estimates differ but CIs overlap",
    a: [6, 30], d: [8, 30], expectPromote: false,
  },
  {
    label: "clear win: 80/200 vs 30/200 — non-overlap",
    a: [30, 200], d: [80, 200], expectPromote: true,
  },
  {
    label: "small n big diff: 0/30 vs 10/30 — should still NOT promote (CIs touch)",
    a: [0, 30], d: [10, 30], expectPromote: false,
  },
  {
    label: "large n small diff: 100/1000 vs 130/1000 — should promote (CIs separate)",
    a: [100, 1000], d: [130, 1000], expectPromote: true,
  },
] as const;

for (const c of decisionCases) {
  const [aClick, aSent] = c.a;
  const [dClick, dSent] = c.d;
  const [aLow, aHigh] = wilsonCI(aClick, aSent);
  const [dLow, dHigh] = wilsonCI(dClick, dSent);
  const promote = dLow > aHigh;
  const ok = promote === c.expectPromote;
  if (!ok) allPass = false;
  console.log(
    `  ${ok ? "✅" : "❌"} ${c.label}\n` +
    `     active CI [${(aLow * 100).toFixed(1)}, ${(aHigh * 100).toFixed(1)}]; ` +
    `draft CI [${(dLow * 100).toFixed(1)}, ${(dHigh * 100).toFixed(1)}]; ` +
    `promote=${promote} (expected ${c.expectPromote})\n`,
  );
}

if (!allPass) {
  console.log("❌ One or more cases failed");
  process.exit(1);
}
console.log("✅ All cases pass");

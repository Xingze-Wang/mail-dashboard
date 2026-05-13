let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.error(`  ✗ ${msg}`); fail++; } };

console.log("Test 1: wilsonInterval — k=0 of n=30 yields lower bound 0");
{
  const { wilsonInterval } = await import("../src/lib/template-candidate-gate.ts");
  const ci = wilsonInterval(0, 30, 0.95);
  assert(Math.abs(ci.lower - 0) < 0.001, `lower ≈ 0 (got ${ci.lower})`);
  assert(ci.upper > 0 && ci.upper < 0.2, `upper between 0 and 0.2 (got ${ci.upper})`);
}

console.log("\nTest 2: wilsonInterval — k=15 of n=30 yields ~50% point estimate");
{
  const { wilsonInterval } = await import("../src/lib/template-candidate-gate.ts");
  const ci = wilsonInterval(15, 30, 0.95);
  assert(ci.lower > 0.3 && ci.lower < 0.5, `lower in (0.3, 0.5) (got ${ci.lower})`);
  assert(ci.upper > 0.5 && ci.upper < 0.7, `upper in (0.5, 0.7) (got ${ci.upper})`);
}

console.log("\nTest 3: evaluateCandidate — both signals strong → pass");
{
  const { evaluateCandidate } = await import("../src/lib/template-candidate-gate.ts");
  const res = evaluateCandidate({
    perRep: { clicked: 10, sent: 30 },
    global:  { clicked: 5,  sent: 100 },
    perRepPredicted: 0.30,
    globalPredicted: 0.10,
    predictedLiftRequired: 1.1,
  });
  assert(res.passes === true, "passes");
  assert(res.actualSignalAgrees === true, "actual signal agrees");
  assert(res.predictedSignalAgrees === true, "predicted signal agrees");
}

console.log("\nTest 4: evaluateCandidate — actual strong, predicted weak → fail");
{
  const { evaluateCandidate } = await import("../src/lib/template-candidate-gate.ts");
  const res = evaluateCandidate({
    perRep: { clicked: 10, sent: 30 },
    global:  { clicked: 5,  sent: 100 },
    perRepPredicted: 0.10,
    globalPredicted: 0.10,
    predictedLiftRequired: 1.1,
  });
  assert(res.passes === false, "fails (predicted disagrees)");
  assert(res.predictedSignalAgrees === false, "predicted signal disagrees");
}

console.log("\nTest 5: evaluateCandidate — actual CIs overlap → fail");
{
  const { evaluateCandidate } = await import("../src/lib/template-candidate-gate.ts");
  const res = evaluateCandidate({
    perRep: { clicked: 11, sent: 100 },
    global:  { clicked: 9,  sent: 100 },
    perRepPredicted: 0.20,
    globalPredicted: 0.10,
    predictedLiftRequired: 1.1,
  });
  assert(res.passes === false, "fails (actual CIs overlap)");
  assert(res.actualSignalAgrees === false, "actual signal disagrees");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

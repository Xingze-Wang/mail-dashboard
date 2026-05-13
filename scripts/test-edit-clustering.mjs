/**
 * Integration test for src/lib/edit-clustering.ts.
 * Run: npx tsx --env-file=.env.local scripts/test-edit-clustering.mjs
 */

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.error(`  ✗ ${msg}`); fail++; } };

console.log("Test 1: cosine of identical vectors is 1");
{
  const { cosine } = await import("../src/lib/edit-clustering.ts");
  const a = [1, 0, 0, 0];
  assert(Math.abs(cosine(a, a) - 1) < 1e-6, "cosine(a,a) ≈ 1");
}

console.log("\nTest 2: cosine of orthogonal vectors is 0");
{
  const { cosine } = await import("../src/lib/edit-clustering.ts");
  const a = [1, 0, 0, 0];
  const b = [0, 1, 0, 0];
  assert(Math.abs(cosine(a, b)) < 1e-6, "cosine(a,b) ≈ 0");
}

console.log("\nTest 3: clusterEdits groups similar embeddings");
{
  const { clusterEdits } = await import("../src/lib/edit-clustering.ts");
  const items = [
    { id: "a1", vec: [1, 0, 0, 0] },
    { id: "a2", vec: [0.95, 0.05, 0, 0] },
    { id: "a3", vec: [0.9, 0.1, 0, 0] },
    { id: "b1", vec: [0, 1, 0, 0] },
    { id: "b2", vec: [0, 0.95, 0.05, 0] },
  ];
  const clusters = clusterEdits(items, 0.85);
  assert(clusters.length === 2, `got ${clusters.length} clusters (expect 2)`);
  const sizes = clusters.map((c) => c.members.length).sort((x, y) => y - x);
  assert(sizes[0] === 3 && sizes[1] === 2, `cluster sizes ${sizes} (expect [3,2])`);
}

console.log("\nTest 4: pickMedoid returns the member closest to centroid");
{
  const { pickMedoid } = await import("../src/lib/edit-clustering.ts");
  const members = [
    { id: "x", vec: [1, 0] },
    { id: "y", vec: [0.99, 0.01] },
    { id: "z", vec: [0.7, 0.3] },
  ];
  const centroid = [0.95, 0.05];
  const med = pickMedoid(members, centroid);
  assert(med.id === "y", `medoid is y (got ${med.id})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

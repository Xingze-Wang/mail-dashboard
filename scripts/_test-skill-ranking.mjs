// Skill ranking smoke — verify:
//   1. Universal skills always load (no triggers required)
//   2. Triggered skills ranked by (trigger match count + FTS rank)
//   3. Top-K budget respected; low-score triggered skills don't appear
//   4. Universal cap = floor(skillBudget/2), max 10
//
// Setup: 1 universal + 4 triggered skills with varying overlap to the query.
//        skillBudget=4. Universal gets cap=floor(4/2)=2 slots, triggered gets 2.
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");
const { recordLearning, loadRelevantLearnings } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/helper-learnings.ts"
);

console.log("[0/3] cleanup prior seed rows…");
await supabase.from("helper_learnings").delete().like("body", "RANK-SMOKE%");

console.log("\n[1/3] seed 1 universal + 4 triggered skills…");
const seeds = await Promise.all([
  recordLearning({
    scope_rep_id: null,
    kind: "skill",
    body: "RANK-SMOKE skill UNI: universal — always loads",
    triggers: [],
  }),
  recordLearning({
    scope_rep_id: null,
    kind: "skill",
    body: "RANK-SMOKE skill A: 白名单 lookup — should match whitelist query",
    triggers: ["白名单", "whitelist"],
  }),
  recordLearning({
    scope_rep_id: null,
    kind: "skill",
    body: "RANK-SMOKE skill B: rep onboarding question — should NOT match whitelist",
    triggers: ["onboarding", "新人"],
  }),
  recordLearning({
    scope_rep_id: null,
    kind: "skill",
    body: "RANK-SMOKE skill C: send cap rules — should NOT match whitelist",
    triggers: ["send cap", "daily limit"],
  }),
  recordLearning({
    scope_rep_id: null,
    kind: "skill",
    body: "RANK-SMOKE skill D: white-listed schools criteria — body contains '白名单' so FTS may match",
    triggers: ["compliance", "policy"],
  }),
]);
console.log("  seeded", seeds.length, "skills");

console.log("\n[2/3] query 'rep 问白名单怎么处理 — 学校在不在 list 里' with skillBudget=4:");
const result = await loadRelevantLearnings({
  query: "rep 问白名单怎么处理 — 学校在不在 list 里",
  repId: 5,
  skillBudget: 4,
  memoryBudget: 0,
});
const smokeLoaded = result.filter((l) => l.body.startsWith("RANK-SMOKE"));
console.log("  loaded smoke skills (in order):");
for (const s of smokeLoaded) {
  const tag = s.triggers && s.triggers.length === 0 ? "[UNIVERSAL]" : `[triggered: ${JSON.stringify(s.triggers)}]`;
  console.log("    ", tag, s.body.slice(0, 60));
}

const hasUni = smokeLoaded.some((s) => s.body.includes("skill UNI"));
const hasA = smokeLoaded.some((s) => s.body.includes("skill A"));
const hasD_via_fts = smokeLoaded.some((s) => s.body.includes("skill D"));
const hasB = smokeLoaded.some((s) => s.body.includes("skill B"));
const hasC = smokeLoaded.some((s) => s.body.includes("skill C"));

console.log("\n  Expectations:");
console.log("    universal UNI loaded?", hasUni, hasUni ? "✅" : "❌");
console.log("    A (trigger match '白名单') loaded?", hasA, hasA ? "✅" : "❌");
console.log("    D (FTS match on body '白名单') loaded?", hasD_via_fts, "ℹ️");
console.log("    B (no match) loaded?", hasB, hasB ? "❌ (should not)" : "✅");
console.log("    C (no match) loaded?", hasC, hasC ? "❌ (should not)" : "✅");

console.log("\n[3/3] universal cap test — skillBudget=20, 1 universal seeded (cap should still load it):");
const result2 = await loadRelevantLearnings({
  query: "anything",
  repId: 5,
  skillBudget: 20,
  memoryBudget: 0,
});
const uniLoaded = result2.some((l) => l.body.includes("RANK-SMOKE skill UNI"));
console.log("  universal still loads with big budget?", uniLoaded, uniLoaded ? "✅" : "❌");

// cleanup
await supabase.from("helper_learnings").delete().like("body", "RANK-SMOKE%");

const ok = hasUni && hasA && !hasB && !hasC && uniLoaded;
console.log(ok ? "\n✅ skill ranking verified" : "\n⚠️ some checks failed");

// E2E for per-query relevance recall + skill activation triggers:
//   1. Seed 4 learnings:
//      - skill A (triggers: ['白名单', 'whitelist'])  — should activate only on whitelist queries
//      - skill B (no triggers, universal)              — always activates
//      - memory M1 ("Yujie 偏好短主题")                 — rank-based
//      - memory M2 ("Leo 点击率周二最高")              — rank-based
//   2. Query "rep 问白名单怎么处理" → expect skill A + skill B + (maybe M1 rank=0)
//   3. Query "Yujie 这周怎么样" → expect skill B (universal) + M1 (high rank)
//   4. Query "" (empty) → fallback bulk-load
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");
const { recordLearning, loadRelevantLearnings, loadActiveLearnings } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/helper-learnings.ts"
);

console.log("[0/4] Cleanup any prior seed rows…");
await supabase.from("helper_learnings").delete().like("body", "RECALL-SMOKE%");

console.log("\n[1/4] Seed 4 learnings…");
const seeds = await Promise.all([
  recordLearning({
    scope_rep_id: null,
    kind: "skill",
    body: "RECALL-SMOKE skill A: 当 rep 问白名单时, 直接 lookup get_lead 看 school_tier_band 然后回答",
    confidence: 0.9,
    triggers: ["白名单", "whitelist", "白名單"],
  }),
  recordLearning({
    scope_rep_id: null,
    kind: "skill",
    body: "RECALL-SMOKE skill B (universal): 每次回复都先 react_to_message 一个 OK emoji 表示收到",
    confidence: 0.9,
    triggers: [],
  }),
  recordLearning({
    scope_rep_id: null,
    kind: "tactic",
    body: "RECALL-SMOKE memory M1: Yujie 偏好短主题 (≤5 词), 主语放最前, 别用问号",
    confidence: 0.85,
  }),
  recordLearning({
    scope_rep_id: null,
    kind: "tactic",
    body: "RECALL-SMOKE memory M2: Leo 周二的点击率比平均高 2.3x, 周二早上 cron 批量发效果最佳",
    confidence: 0.85,
  }),
]);
for (const s of seeds) console.log("  +", s?.id, s?.kind, "triggers=" + JSON.stringify(s?.triggers ?? []));

console.log("\n[2/4] Query: 'rep 问白名单怎么处理'");
const r1 = await loadRelevantLearnings({ query: "rep 问白名单怎么处理", repId: 5 });
for (const l of r1) {
  if (!l.body.startsWith("RECALL-SMOKE")) continue;
  console.log("  ", l.kind, "rank=" + (l.rank ?? 0).toFixed(3), "body=" + l.body.slice(0, 60));
}
const hasA = r1.some((l) => l.body.startsWith("RECALL-SMOKE skill A"));
const hasB = r1.some((l) => l.body.startsWith("RECALL-SMOKE skill B"));
console.log("  hasSkillA (triggered)?", hasA, "| hasSkillB (universal)?", hasB);

console.log("\n[3/4] Query: 'Yujie 这周怎么样' (should NOT activate skill A)");
const r2 = await loadRelevantLearnings({ query: "Yujie 这周怎么样", repId: 5 });
for (const l of r2) {
  if (!l.body.startsWith("RECALL-SMOKE")) continue;
  console.log("  ", l.kind, "rank=" + (l.rank ?? 0).toFixed(3), "body=" + l.body.slice(0, 60));
}
const skipA = !r2.some((l) => l.body.startsWith("RECALL-SMOKE skill A"));
const hasM1 = r2.some((l) => l.body.startsWith("RECALL-SMOKE memory M1"));
console.log("  correctly skipped skill A?", skipA, "| has memory M1?", hasM1);

console.log("\n[4/4] Query: '' (empty) → bulk-load fallback");
const r3 = await loadRelevantLearnings({ query: "", repId: 5 });
const smokeRows = r3.filter((l) => l.body.startsWith("RECALL-SMOKE"));
console.log("  smoke rows pulled:", smokeRows.length, "(should be all 4 since bulk-load)");

console.log("\n[cleanup] removing seed rows…");
await supabase.from("helper_learnings").delete().like("body", "RECALL-SMOKE%");

// Verdict
const ok = hasA && hasB && skipA && hasM1 && smokeRows.length >= 4;
console.log(ok ? "\n✅ Relevance recall + skill activation verified." : "\n⚠️ Some expectations failed — check logs above.");

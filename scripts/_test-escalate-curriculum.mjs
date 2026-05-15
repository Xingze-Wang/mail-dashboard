// End-to-end smoke for the escalation + curriculum loop.
//
//   1. Simulate a rep DMing Leon with an uncertain question (via runReadTool)
//   2. Verify admin_inbox + Lark card pushed
//   3. Insert 3 synthetic rep_questions across 2 reps
//   4. Run curriculum-miner POST (dry first, then real)
//   5. Verify a kind=idea admin_inbox row appears for the cluster
//   6. Verify get_helper_conversation tool returns user+assistant turns
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");
const { runReadTool } = await import("/Users/xingzewang/Desktop/mail/src/lib/helper-read-tools.ts");

const session = { repId: 5, role: "admin", repName: "Xingze (smoke)", email: "smoke@example.com" };

console.log("\n[1/6] escalate_to_admin tool…");
const esc = await runReadTool(session, {
  tool: "escalate_to_admin",
  args: {
    question: "SMOKE: should Leo email .gov targets?",
    my_best_guess: "I think we avoid .gov per the compliance memo, but I haven't seen it written down.",
    why_unsure: "No qiji-facts entry covers .gov; this hasn't come up before.",
    asked_by_rep_id: 1,
  },
});
console.log("  escalate_to_admin →", esc.result);

console.log("\n[2/6] Verifying admin_inbox row landed (kind=request)…");
const escId = esc.result.id;
const { data: row } = await supabase
  .from("admin_inbox")
  .select("id, kind, headline, status, evidence")
  .eq("id", escId)
  .maybeSingle();
console.log("  row:", row?.kind, "/", row?.status, "/ headline:", row?.headline?.slice(0, 80));
console.log("  evidence.my_best_guess:", row?.evidence?.my_best_guess?.slice(0, 80));

console.log("\n[3/6] Inserting 3 synthetic rep_questions (cluster across 2 reps)…");
const ts = Date.now();
const samples = [
  { rep_id: 1, raw_text: "SMOKE-curriculum: 如果 lead 的学校不在白名单里, 还能发吗?" },
  { rep_id: 2, raw_text: "SMOKE-curriculum: 学校不在白名单的 lead 是不是不能发?" },
  { rep_id: 1, raw_text: "SMOKE-curriculum: 白名单外的学校 lead 怎么处理?" },
];
const inserts = samples.map((s) => ({
  rep_id: s.rep_id,
  raw_text: s.raw_text,
  normalized: s.raw_text.toLowerCase().replace(/smoke-curriculum:/g, "").trim(),
  outcome: "deferred",
}));
const { error: insErr } = await supabase.from("rep_questions").insert(inserts);
if (insErr) { console.error("  insert failed:", insErr.message); process.exit(1); }
console.log("  inserted 3 rows across rep_ids:", Array.from(new Set(samples.map((s) => s.rep_id))));

console.log("\n[4/6] Running curriculum-miner (dry)…");
const minerMod = await import("/Users/xingzewang/Desktop/mail/src/app/api/cron/curriculum-miner/route.ts");
// Use the internal run() function via the GET path. We invoke directly with a synthetic auth.
process.env.CRON_SECRET = process.env.CRON_SECRET || "smoke-secret";
const req = new Request("http://localhost/api/cron/curriculum-miner?dry=1", {
  headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
});
const resDry = await minerMod.GET(req);
const jDry = await resDry.json();
console.log("  dry result: questions_pulled=" + jDry.questions_pulled + " clusters_found=" + jDry.clusters_found + " promoted=" + jDry.clusters_promoted_to_inbox);
for (const d of jDry.details ?? []) {
  console.log("    cluster medoid:", d.medoid_normalized?.slice(0, 60), "| reps:", d.distinct_reps, "| skipped:", d.skipped_reason);
}

console.log("\n[5/6] Running curriculum-miner (real)…");
const req2 = new Request("http://localhost/api/cron/curriculum-miner", {
  headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
});
const resReal = await minerMod.GET(req2);
const jReal = await resReal.json();
console.log("  real result: clusters_found=" + jReal.clusters_found + " promoted=" + jReal.clusters_promoted_to_inbox + " skipped_dup=" + jReal.clusters_skipped_dup);
for (const d of jReal.details ?? []) {
  if (d.inbox_id && !d.skipped_reason) console.log("    🆕 inbox_id=" + d.inbox_id, "| medoid:", d.medoid_normalized?.slice(0, 60));
  else console.log("    skipped:", d.skipped_reason, "| medoid:", d.medoid_normalized?.slice(0, 60));
}

console.log("\n[6/6] get_helper_conversation tool (admin reads rep 5's history)…");
const conv = await runReadTool(session, {
  tool: "get_helper_conversation",
  args: { repId: 5, limit: 5, days: 7 },
});
console.log("  turnCount:", conv.result.turnCount);
for (const t of (conv.result.turns ?? []).slice(0, 3)) {
  console.log("   ", t.role, "[" + t.surface + "]:", t.text.slice(0, 70));
}

console.log("\n[cleanup] removing smoke rep_questions…");
await supabase.from("rep_questions").delete().like("raw_text", "SMOKE-curriculum:%");

console.log("\n✅ Smoke complete. Check Lark for two cards (escalation + curriculum).");

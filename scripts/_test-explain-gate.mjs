import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
const { proposeDynamicTool } = await import("/Users/xingzewang/Desktop/mail/src/lib/dynamic-tools.ts");
const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");

// Bad SQL: should be rejected
const r1 = await proposeDynamicTool({
  name: "smoke_bad_col_test",
  description: "should be rejected by EXPLAIN gate",
  args_schema: { days: { type: "number", default: 7 } },
  param_order: ["days"],
  sql_template: "select count(*) from pipeline_leads where wechat_added_at >= now() - ($1::int || ' days')::interval",
  proposal_reason: "smoke test for EXPLAIN gate",
  proposed_by_rep_id: 5,
});
console.log("[bad SQL] ok=" + r1.ok + " error=" + (r1.error ?? "—"));

// Good SQL: should pass
const r2 = await proposeDynamicTool({
  name: "smoke_valid_count_" + Date.now(),
  description: "should pass the gate",
  args_schema: { days: { type: "number", default: 7 } },
  param_order: ["days"],
  sql_template: "select count(*) from pipeline_leads where created_at >= now() - ($1::int || ' days')::interval",
  proposal_reason: "smoke test for valid path",
  proposed_by_rep_id: 5,
});
console.log("[valid SQL] ok=" + r2.ok + " id=" + (r2.id ?? "—"));
if (r2.ok) {
  await supabase.from("dynamic_tools").delete().eq("id", r2.id);
  if (r2.inbox_id) await supabase.from("admin_inbox").delete().eq("id", r2.inbox_id);
}

// E2E smoke for the propose_db_write loop:
//   1. validateWriteSql rejects bad inputs (SELECT, DDL, forbidden tables)
//   2. proposeDynamicWrite creates a pending row + (with SMOKE_NO_CARDS) skips Lark
//   3. Yes-click path runs through processAdminInboxCardAction → applyDynamicWrite
//   4. db_write_log records the action
//   5. The actual DB change landed (we use helper_learnings — easy to clean up)
import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = "1";

const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");
const { validateWriteSql, proposeDynamicWrite, applyDynamicWrite } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/dynamic-writes.ts"
);
const { processAdminInboxCardAction } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/admin-inbox-card.ts"
);

console.log("[1/5] validateWriteSql guards:");
const guards = [
  { sql: "SELECT * FROM sales_reps", expect_ok: false, msg: "SELECT must be rejected" },
  { sql: "DROP TABLE sales_reps", expect_ok: false, msg: "DROP must be rejected" },
  { sql: "DELETE FROM emails WHERE id = $1", expect_ok: false, msg: "emails table is forbidden" },
  { sql: "UPDATE sales_reps SET role = $1 WHERE id = $2", expect_ok: true, msg: "allowed UPDATE" },
  { sql: "DELETE FROM helper_learnings WHERE id = $1", expect_ok: true, msg: "allowed DELETE" },
  { sql: "INSERT INTO helper_learnings (kind, body, confidence) VALUES ($1, $2, $3)", expect_ok: true, msg: "allowed INSERT" },
  { sql: "UPDATE sales_reps SET role = 'sales' WHERE id = 1; DROP TABLE x", expect_ok: false, msg: "no semicolons mid-body" },
];
let passed = 0;
for (const g of guards) {
  const r = validateWriteSql(g.sql);
  const ok = r.ok === g.expect_ok;
  if (ok) passed++;
  console.log("  ", ok ? "✅" : "❌", g.msg, "— got:", r.ok ? `ok table=${r.table}` : `error: ${r.reason}`);
}
console.log(`  ${passed}/${guards.length} guards passed`);

console.log("\n[2/5] propose a write (INSERT into helper_learnings)…");
const uniqueBody = "SMOKE-WRITE: dynamic write loop check " + Date.now();
const proposal = await proposeDynamicWrite({
  description: "Test insert: prove the propose→approve→execute loop works.",
  sql_template: "INSERT INTO helper_learnings (kind, body, confidence) VALUES ($1::text, $2::text, $3::float)",
  param_values: ["other", uniqueBody, 0.5],
  proposal_reason: "Smoke test for the dynamic_writes loop. Will be cleaned up.",
  proposed_by_rep_id: 5,
});
console.log("  →", proposal);
if (!proposal.ok) process.exit(1);

console.log("\n[3/5] simulate Yes click via processAdminInboxCardAction…");
const { data: admin } = await supabase.from("sales_reps").select("lark_open_id").eq("id", 5).maybeSingle();
const clickRes = await processAdminInboxCardAction({
  event: {
    operator: { open_id: admin?.lark_open_id },
    action: { value: { admin_inbox_action: "yes", inbox_id: proposal.inbox_id } },
  },
});
console.log("  click result:", clickRes);

console.log("\n[4/5] verify dynamic_writes row + db_write_log entry…");
const { data: w } = await supabase
  .from("dynamic_writes")
  .select("status, applied_at, apply_result, apply_error")
  .eq("id", proposal.id)
  .maybeSingle();
console.log("  dynamic_writes status:", w?.status, "| applied_at:", w?.applied_at, "| apply_result:", JSON.stringify(w?.apply_result));

const { data: log } = await supabase
  .from("db_write_log")
  .select("source, table_name, ok, rows_affected, error")
  .eq("proposal_id", proposal.id)
  .maybeSingle();
console.log("  db_write_log:", log);

console.log("\n[5/5] verify the actual INSERT landed in helper_learnings…");
const { data: inserted } = await supabase
  .from("helper_learnings")
  .select("id, kind, body")
  .eq("body", uniqueBody)
  .maybeSingle();
console.log("  inserted row:", inserted ? `✅ id=${inserted.id}` : "❌ NOT FOUND");

// Cleanup
console.log("\n[cleanup] removing smoke artifacts…");
if (inserted) await supabase.from("helper_learnings").delete().eq("id", inserted.id);
await supabase.from("db_write_log").delete().eq("proposal_id", proposal.id);
await supabase.from("dynamic_writes").delete().eq("id", proposal.id);
if (proposal.inbox_id) await supabase.from("admin_inbox").delete().eq("id", proposal.inbox_id);

const verdict = passed === guards.length && w?.status === "applied" && log?.ok === true && !!inserted;
console.log(verdict ? "\n✅ dynamic_writes loop verified." : "\n⚠️ Some checks failed.");

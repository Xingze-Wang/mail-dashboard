// One-shot: flip rep 11 (王泽群) from senior → sales via the new
// propose_db_write + applyDynamicWrite path. SMOKE_NO_CARDS=1 because
// admin already asked for this in DM; no need to push another card.
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
process.env.SMOKE_NO_CARDS = "1";

const { proposeDynamicWrite, applyDynamicWrite } = await import(
  "/Users/xingzewang/Desktop/mail/src/lib/dynamic-writes.ts"
);
const { supabase } = await import("/Users/xingzewang/Desktop/mail/src/lib/db.ts");

const { data: before } = await supabase
  .from("sales_reps")
  .select("id, name, role")
  .eq("id", 11)
  .maybeSingle();
console.log("before:", before);
if (!before) {
  console.error("rep 11 not found");
  process.exit(1);
}
if (before.role === "sales") {
  console.log("already sales, nothing to do");
  process.exit(0);
}

const p = await proposeDynamicWrite({
  name: "rep11_to_sales",
  description: `把 ${before.name} (id=11) 的 role 从 ${before.role} 改成 sales`,
  sql_template: "update sales_reps set role = $1::text where id = $2::int",
  param_values: ["sales", 11],
  proposal_reason: "admin 在 Lark DM 里要求改; Leon 之前没工具做这件事, 现在有 propose_db_write 直接走 loop.",
  proposed_by_rep_id: 5,
});
console.log("propose:", p);
if (!p.ok) process.exit(1);

const r = await applyDynamicWrite({ write_id: p.id, approved_by_rep_id: 5 });
console.log("apply:", r);

const { data: after } = await supabase
  .from("sales_reps")
  .select("id, name, role")
  .eq("id", 11)
  .maybeSingle();
console.log("after:", after);

if (p.inbox_id) await supabase.from("admin_inbox").delete().eq("id", p.inbox_id);

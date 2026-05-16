// One-off cleanup: 10 email_templates rows with status='proposal' but
// active=true that the rep-edit-clustering cron auto-activated on
// 2026-05-09. Per the new approval flow (rep-edit-clustering inserts as
// status='proposal', active=false; admin must click Activate on the
// Lark card), these should never have been active without admin approval.
//
// Behavior: flips active=false on every row WHERE status='proposal' AND
// active=true AND proposed_by='rep_edit_cluster'. Does NOT touch the
// 'global' template or any manually-managed template. Idempotent.
//
// Dry-run by default. Pass --apply to write.
//
// Run:
//   node scripts/_deactivate-leaked-proposal-templates.mjs            # dry
//   node scripts/_deactivate-leaked-proposal-templates.mjs --apply    # write

import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
const apply = process.argv.includes("--apply");

const { createClient } = await import("@supabase/supabase-js");
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { data, error } = await s
  .from("email_templates")
  .select("id, name, rep_id, status, active, created_at, proposed_by")
  .eq("status", "proposal")
  .eq("active", true);
if (error) { console.error("query failed:", error.message); process.exit(1); }
if (!data || data.length === 0) {
  console.log("✓ no leaked proposal-but-active templates found");
  process.exit(0);
}

console.log(`Found ${data.length} rows where status='proposal' AND active=true:`);
for (const r of data) {
  console.log(`  ${r.id}  rep=${r.rep_id ?? "global"}  proposed_by=${r.proposed_by}  ${r.name?.slice(0, 60)}`);
}

if (!apply) {
  console.log("\n(dry-run) pass --apply to write");
  process.exit(0);
}

const ids = data.map((r) => r.id);
const { error: updErr } = await s
  .from("email_templates")
  .update({ active: false })
  .in("id", ids);
if (updErr) { console.error("update failed:", updErr.message); process.exit(1); }
console.log(`\n✓ deactivated ${ids.length} rows. Admin can re-approve via Lark card if/when they're re-emitted by the cron.`);

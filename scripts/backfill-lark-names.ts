/**
 * For every active rep with lark_open_id, call getLarkUserInfo and
 * cache the canonical Lark display name into sales_reps.lark_name
 * (migration 067). Does NOT touch sales_reps.name / sender_name —
 * those stay as the customer-facing English handle.
 *
 * History note: an earlier version of this script overwrote name +
 * sender_name with the Lark Han form. User reverted: keep English
 * handles for customer-facing fields, store Han name separately on
 * lark_name for internal matching only.
 *
 * Idempotent. Safe to run any time drift is suspected.
 *
 * Run: set -a && source .env.local && set +a && npx tsx scripts/backfill-lark-names.ts
 */
import { getLarkUserInfo } from "../src/lib/lark";
import { supabase } from "../src/lib/db";

async function main() {
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, name, lark_name, lark_open_id, active")
    .eq("active", true)
    .not("lark_open_id", "is", null);

  if (!reps || reps.length === 0) {
    console.log("no active reps with lark_open_id; nothing to backfill");
    return;
  }

  for (const rep of reps) {
    const info = await getLarkUserInfo(rep.lark_open_id!);
    if (!info.ok || !info.name) {
      console.log(`  rep_id=${rep.id} ${rep.name}: lark fetch failed (${info.error ?? "no name"}) — skip`);
      continue;
    }
    const larkHanName = info.name.trim();
    if (rep.lark_name === larkHanName) {
      console.log(`  rep_id=${rep.id} ${rep.name}: lark_name already cached (${larkHanName}) — skip`);
      continue;
    }
    const { error } = await supabase
      .from("sales_reps")
      .update({ lark_name: larkHanName })
      .eq("id", rep.id);
    if (error) {
      console.log(`  rep_id=${rep.id}: update failed — ${error.message}`);
      continue;
    }
    console.log(
      `  rep_id=${rep.id} ${rep.name}: lark_name '${rep.lark_name ?? "(null)"}' → '${larkHanName}' (name unchanged)`,
    );
  }
  console.log("\nbackfill done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

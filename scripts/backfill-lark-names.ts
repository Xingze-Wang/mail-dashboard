/**
 * One-shot: for every active rep with lark_open_id, call
 * getLarkUserInfo and update their `name` + `sender_name` to the
 * canonical Lark display name.
 *
 * Why this exists: pre-existing reps were inserted via manual SQL
 * migrations and their `name` was whatever I typed (often pinyin or
 * a guess). Once their lark_open_id is bound, Lark IS the source of
 * truth for what they actually go by — using anything else means our
 * dashboard, email signatures, and AI prompts all show a name that
 * isn't really theirs.
 *
 * Idempotent: running twice produces the same result. Safe to run
 * after every onboarding too if drift is suspected.
 *
 * Run: set -a && source .env.local && set +a && npx tsx scripts/backfill-lark-names.ts
 */
import { getLarkUserInfo } from "../src/lib/lark";
import { supabase } from "../src/lib/db";

async function main() {
  const { data: reps } = await supabase
    .from("sales_reps")
    .select("id, name, sender_name, lark_open_id, active")
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
    const larkName = info.name.trim();
    if (rep.name === larkName && rep.sender_name === larkName) {
      console.log(`  rep_id=${rep.id} ${rep.name}: already canonical (${larkName}) — skip`);
      continue;
    }
    const { error } = await supabase
      .from("sales_reps")
      .update({ name: larkName, sender_name: larkName })
      .eq("id", rep.id);
    if (error) {
      console.log(`  rep_id=${rep.id}: update failed — ${error.message}`);
      continue;
    }
    console.log(`  rep_id=${rep.id}: '${rep.name}' / '${rep.sender_name}' → '${larkName}'`);
  }
  console.log("\nbackfill done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

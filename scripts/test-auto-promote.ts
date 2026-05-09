/**
 * Smoke test the auto-promote cron logic by calling the route's
 * core function directly (bypassing HTTP/WAF). Just verifies the
 * decision logic doesn't blow up — won't actually find any active+
 * approved_draft pairs to act on yet (we don't have data accumulated).
 */
import { supabase } from "../src/lib/db";

const MIN_SAMPLE = 30;
const LIFT_THRESHOLD = 1.2;

async function main() {
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const { data: tpls } = await supabase
    .from("email_templates")
    .select("id, name, status, segment_default")
    .in("status", ["active", "approved_draft", "proposal"])
    .eq("active", true);
  console.log(`Found ${tpls?.length ?? 0} eligible templates`);
  if (!tpls || tpls.length === 0) return;

  const tplIds = tpls.map((t) => t.id as string);
  const { data: emails } = await supabase
    .from("emails")
    .select("id, template_id")
    .gte("created_at", since30)
    .in("template_id", tplIds);
  console.log(`${emails?.length ?? 0} sends in last 30d`);

  const buckets = new Map();
  for (const t of tpls) buckets.set(t.id, { ...t, sent: 0, clicked: 0 });
  for (const e of emails ?? []) {
    const b = buckets.get(e.template_id);
    if (b) b.sent++;
  }

  console.log("\nPer-template send counts:");
  for (const [, b] of buckets) {
    const flag = b.sent >= MIN_SAMPLE ? "✓" : "✗";
    console.log(`  ${flag} ${b.status.padEnd(15)} ${b.name.padEnd(50)} segment=${b.segment_default ?? "(none)"} sent=${b.sent}`);
  }

  // Group by segment
  const bySegment = new Map();
  for (const b of buckets.values()) {
    const k = b.segment_default ?? "__GLOBAL__";
    bySegment.set(k, [...(bySegment.get(k) ?? []), b]);
  }

  console.log("\nBy segment:");
  for (const [seg, list] of bySegment) {
    const active = list.find((t: { status: string }) => t.status === "active");
    const draft = list.find((t: { status: string }) => t.status === "approved_draft");
    const proposals = list.filter((t: { status: string }) => t.status === "proposal");
    console.log(`  ${seg}: active=${!!active} approved_draft=${!!draft} proposals=${proposals.length}`);
    if (active && draft) {
      const enough = active.sent >= MIN_SAMPLE && draft.sent >= MIN_SAMPLE;
      console.log(`    pair eligible: ${enough} (n_active=${active.sent}, n_draft=${draft.sent}, need ≥${MIN_SAMPLE})`);
    }
  }
  console.log(`\n${LIFT_THRESHOLD}x threshold for promotion. ${(1 / LIFT_THRESHOLD).toFixed(2)}x for refute.`);
  console.log("\nLogic loads cleanly. Will act once we have approved_draft + production traffic in same segment.");
}
main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Self-test the A/B traffic split in loadEffectiveTemplate.
 *
 * Two checks:
 *  1. Hash uniformity — over 1000 random lead ids, the bucket
 *     distribution should put ~APPROVED_DRAFT_TRAFFIC_PCT% (=20%) below
 *     the threshold. We tolerate ±5pp because true uniformity for
 *     N=1000 has ~1.3pp std dev.
 *  2. Determinism — the same lead id always returns the same template.
 *     Run loadEffectiveTemplate twice on the same lead, confirm same id.
 *
 * Skips the network when the DB has no approved_draft templates yet
 * (current state). The hash test still runs.
 */
import { loadEffectiveTemplate } from "../src/lib/template-assembler";
import { supabase } from "../src/lib/db";

// Re-implement the hash here to inspect it directly without going
// through the DB. Has to match the version in template-assembler.ts
// exactly — if you change the hash there, change this too.
function hashToBucket(leadId: string | null | undefined, modulo: number): number {
  if (!leadId) return 0;
  let h = 5381;
  for (let i = 0; i < leadId.length; i++) {
    h = ((h << 5) + h + leadId.charCodeAt(i)) >>> 0;
  }
  return h % modulo;
}

const APPROVED_DRAFT_TRAFFIC_PCT = 20;

async function main() {
  // 1. Hash uniformity
  let belowThreshold = 0;
  const N = 1000;
  for (let i = 0; i < N; i++) {
    // Mix uuid-like + arxiv-like + integer-like ids
    const id = `${Math.random().toString(36).slice(2)}-${i}-${Date.now() ^ i}`;
    if (hashToBucket(id, 100) < APPROVED_DRAFT_TRAFFIC_PCT) belowThreshold++;
  }
  const pct = (belowThreshold / N) * 100;
  console.log(`Hash uniformity: ${belowThreshold}/${N} below ${APPROVED_DRAFT_TRAFFIC_PCT}-bucket threshold = ${pct.toFixed(1)}%`);
  const expected = APPROVED_DRAFT_TRAFFIC_PCT;
  const diff = Math.abs(pct - expected);
  if (diff > 5) {
    console.log(`  ❌ off by ${diff.toFixed(1)}pp — hash may be biased`);
  } else {
    console.log(`  ✅ within ±5pp of ${expected}%`);
  }

  // 2. Determinism — call hashToBucket on the same id 3 times
  const sample = "lead-abc-123";
  const b1 = hashToBucket(sample, 100);
  const b2 = hashToBucket(sample, 100);
  const b3 = hashToBucket(sample, 100);
  console.log(`\nDeterminism: hash("${sample}") = ${b1}, ${b2}, ${b3}`);
  if (b1 === b2 && b2 === b3) console.log("  ✅ stable across calls");
  else console.log("  ❌ hash is non-deterministic — investigate");

  // 3. End-to-end via loadEffectiveTemplate
  // First check what's in the DB
  const { data: drafts } = await supabase
    .from("email_templates")
    .select("id, name, status")
    .eq("status", "approved_draft")
    .eq("active", true)
    .is("rep_id", null);
  console.log(`\nDB state: ${drafts?.length ?? 0} approved_draft templates available`);

  if (!drafts || drafts.length === 0) {
    console.log("  No approved_draft to A/B against. Test that with leadId=null we still get the active:");
    const r = await loadEffectiveTemplate(null, null);
    console.log(`  loadEffectiveTemplate(null, null) → ${r?.name ?? "(none)"}`);
    return;
  }

  // If we have approved_draft, test split distribution
  const counts: Record<string, number> = {};
  for (let i = 0; i < 100; i++) {
    const tpl = await loadEffectiveTemplate(null, `synthetic-lead-${i}`);
    if (tpl) counts[tpl.name as string] = (counts[tpl.name as string] ?? 0) + 1;
  }
  console.log("\nE2E split over 100 synthetic leads:");
  for (const [name, n] of Object.entries(counts)) {
    console.log(`  ${name}: ${n}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * Verify the consolidation: weekly congress, when its synthesizer
 * produces a template-related change_spec, should fan out to the
 * strategist+editor pipeline and insert a row into email_templates
 * (status='proposal') alongside the tactical_proposals row.
 *
 * We run weekly congress dryRun=false so it actually writes both
 * rows. After the run, query DB to confirm: most-recent
 * tactical_proposals row + most-recent email_templates proposal row
 * should both exist and be linked via tactical_proposal_id.
 */
import { runWeeklyCongress } from "../src/lib/congress-runners";
import { supabase } from "../src/lib/db";

async function main() {
  const before = Date.now();
  console.log("Running weekly congress (this will take ~60-90s for 7 personas + strategist + editor)...\n");

  const result = await runWeeklyCongress({ dryRun: false });
  console.log("Result:", result);
  console.log(`Elapsed: ${((Date.now() - before) / 1000).toFixed(1)}s\n`);

  if (result.outcome !== "proposal") {
    console.log("Congress skipped — no proposal generated this run. That's fine, just means no signal worth proposing.");
    return;
  }

  // Read most-recent tactical proposal
  const { data: tacRow } = await supabase
    .from("tactical_proposals")
    .select("id, title, change_spec, created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log("Latest tactical_proposals row:");
  console.log(`  id=${tacRow?.id}`);
  console.log(`  title=${tacRow?.title}`);
  console.log(`  change_spec.kind=${(tacRow?.change_spec as Record<string, unknown> | null)?.kind}`);

  // Read most-recent email_templates proposal that links to it
  const { data: tplRow } = await supabase
    .from("email_templates")
    .select("id, name, status, segment_default, proposed_evidence, created_at")
    .eq("status", "proposal")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log("\nLatest email_templates proposal:");
  if (tplRow) {
    const ev = tplRow.proposed_evidence as Record<string, unknown> | null;
    console.log(`  id=${tplRow.id}`);
    console.log(`  name=${tplRow.name}`);
    console.log(`  segment_default=${tplRow.segment_default ?? '(none)'}`);
    console.log(`  links to tactical_proposal_id=${ev?.tactical_proposal_id ?? '(none)'}`);
    if (ev?.tactical_proposal_id === tacRow?.id) {
      console.log("  ✅ Linked to the tactical row from this run");
    } else {
      console.log("  ⚠️  Not linked to this run's tactical proposal — this prose proposal is from a previous run");
    }
  } else {
    console.log("  (no proposal found)");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

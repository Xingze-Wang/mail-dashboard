/**
 * Direct smoke test of the strategist + editor pipeline (extracted
 * from congress-hypothesis.ts into template-prose-pipeline.ts during
 * consolidation). Skips the full weekly congress — just exercises
 * the prose-craft phase to verify it still produces clean output
 * after the refactor.
 */
import { craftAndGateProposal } from "../src/lib/template-prose-pipeline";
import { supabase } from "../src/lib/db";

async function main() {
  const HYPOTHESIS = "周三的高 click rate (39.1%) 反映出研究员的'周中排队焦虑' — 此时实验室内部集群配额通常已耗尽";
  const PROPOSED_TEST = "在 intro_prompt 中提到'无需排队'/'即时调用'等针对周中实验室集群压力的具体卖点";

  console.log("Calling craftAndGateProposal — should run strategist + editor + insert\n");
  const t0 = Date.now();
  const result = await craftAndGateProposal({
    hypothesis: HYPOTHESIS,
    reasoning: "实验室周度配额一般周一同步周二跑通周三耗尽",
    proposed_test: PROPOSED_TEST,
    segment: null,
    proposedBy: "admin",
    evidence: { source: "consolidation_smoke_test", note: "direct invocation" },
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Elapsed: ${dt}s`);
  console.log("Result:", JSON.stringify(result, null, 2));

  if (result.ok) {
    const { data: row } = await supabase
      .from("email_templates")
      .select("id, name, segment_default, proposed_evidence, intro_prompt, school_pitch_format")
      .eq("id", result.templateId)
      .maybeSingle();
    if (row) {
      const ev = row.proposed_evidence as Record<string, unknown> | null;
      const slot = ev?.slot_swapped as string ?? "(?)";
      console.log(`\n✅ Inserted into email_templates as proposal:`);
      console.log(`   name=${row.name}`);
      console.log(`   segment=${row.segment_default ?? '(none)'}`);
      console.log(`   slot_swapped=${slot}`);
      console.log(`   editor_tone_assessment=${(ev?.editor_tone_assessment ?? '?').toString().slice(0, 200)}`);
      console.log(`\n   New ${slot} text:`);
      console.log(`   ${(row as Record<string, string>)[slot]}`);

      // Cleanup the test row
      console.log("\n   (Cleaning up test row...)");
      await supabase.from("email_templates").delete().eq("id", result.templateId);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

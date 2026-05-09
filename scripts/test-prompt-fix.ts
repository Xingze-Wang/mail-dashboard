/**
 * Render against the same TemPose lead (Tzu-Yu) that produced the
 * "能否请您说明一下" failure. With the new intro_prompt, the output
 * should NOT contain 您, NOT contain "请...说明", and SHOULD follow
 * the三段论 structure.
 */
import { assembleDraft, type EmailTemplate, type AssemblyInput } from "../src/lib/template-assembler";
import { supabase } from "../src/lib/db";

async function main() {
  const { data: tpl } = await supabase
    .from("email_templates")
    .select("*")
    .eq("name", "global")
    .eq("status", "active")
    .maybeSingle();
  if (!tpl) throw new Error("no global");

  // Find the TemPose / Tzu-Yu lead. Email pattern from screenshot.
  const { data: lead } = await supabase
    .from("pipeline_leads")
    .select("id, title, abstract, author_email, first_name, school_name, school_tier, matched_directions, assigned_rep_id")
    .ilike("title", "%TemPose%")
    .limit(1)
    .maybeSingle();
  if (!lead) {
    console.log("No TemPose lead found. Trying any badminton-related lead...");
    const { data: alt } = await supabase
      .from("pipeline_leads")
      .select("id, title, abstract, author_email, first_name, school_name, school_tier, matched_directions, assigned_rep_id")
      .or("title.ilike.%Badminton%,title.ilike.%TemPose%")
      .limit(1)
      .maybeSingle();
    if (!alt) { console.error("no lead"); process.exit(1); }
    Object.assign({}, alt);
  }

  const target = lead;
  console.log(`Lead: ${target.author_email}`);
  console.log(`Title: ${target.title}`);
  console.log(`First name: ${target.first_name}`);
  console.log("");

  // Run 3 times to test consistency
  for (let i = 1; i <= 3; i++) {
    console.log(`\n=== Run ${i} ===`);
    const input: AssemblyInput = {
      title: target.title,
      abstract: target.abstract,
      authorEmail: target.author_email,
      firstName: target.first_name,
      schoolName: target.school_name,
      schoolTier: target.school_tier,
      matchedDirections: typeof target.matched_directions === "string"
        ? (() => { try { return JSON.parse(target.matched_directions); } catch { return []; } })()
        : (target.matched_directions ?? []),
      repName: "Ethan",
      repWechatId: "hnyhc5",
    };
    const result = await assembleDraft(tpl as EmailTemplate, input);
    const intro = result.introOutput;
    console.log(`Intro: ${intro}\n`);

    // Run the editor checks
    const violations: string[] = [];
    if (intro.includes("您")) violations.push("CONTAINS 您");
    if (/感谢|谢谢|thank/i.test(intro)) violations.push("THANKS the author");
    if (/请你说明|能否请你|能不能告诉|请解释|能否解释/.test(intro)) violations.push("ASKS author to explain");
    if (/亲爱的|敬爱的|尊敬的/.test(intro)) violations.push("KOWTOW vocab");
    if (/震撼|独家|最强|顶级|国内首家/.test(intro)) violations.push("SALES vocab");
    if (violations.length > 0) {
      console.log(`❌ ${violations.length} violations: ${violations.join(", ")}`);
    } else {
      console.log("✅ All 5 red-line checks pass");
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

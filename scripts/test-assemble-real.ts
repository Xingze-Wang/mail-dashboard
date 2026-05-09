/**
 * Self-test the inspect path end-to-end. Calls assembleDraft from CLI
 * (using tsx) against the global template + a real recent lead,
 * exercising the Gemini-via-proxy migration. If FAILED_PRECONDITION
 * comes back, the fix isn't actually working.
 */
import { assembleDraft, type EmailTemplate, type AssemblyInput } from "../src/lib/template-assembler";
import { supabase } from "../src/lib/db";

async function main() {
  console.log("Pulling global template + recent lead...");
  const { data: tpl } = await supabase
    .from("email_templates")
    .select("*")
    .eq("name", "global")
    .eq("active", true)
    .maybeSingle();
  if (!tpl) { console.error("no global template"); process.exit(1); }

  const { data: lead } = await supabase
    .from("pipeline_leads")
    .select("id, title, abstract, author_email, first_name, school_name, school_tier, matched_directions, assigned_rep_id")
    .not("assigned_rep_id", "is", null)
    .not("title", "is", null)
    .not("abstract", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!lead) { console.error("no eligible lead"); process.exit(1); }

  let repName = "Leon", repWechat = "";
  if (lead.assigned_rep_id) {
    const { data: rep } = await supabase
      .from("sales_reps")
      .select("sender_name, name, wechat_id")
      .eq("id", lead.assigned_rep_id)
      .maybeSingle();
    if (rep) {
      repName = (rep.sender_name as string | null) ?? (rep.name as string | null) ?? "Leon";
      repWechat = (rep.wechat_id as string | null) ?? "";
    }
  }

  const input: AssemblyInput = {
    title: lead.title,
    abstract: lead.abstract,
    authorEmail: lead.author_email,
    firstName: lead.first_name,
    schoolName: lead.school_name,
    schoolTier: lead.school_tier,
    matchedDirections: typeof lead.matched_directions === "string"
      ? (() => { try { return JSON.parse(lead.matched_directions); } catch { return []; } })()
      : (lead.matched_directions ?? []),
    repName,
    repWechatId: repWechat,
  };

  console.log(`\nLead: ${lead.author_email} / ${lead.school_name} (tier ${lead.school_tier})`);
  console.log(`Title: ${lead.title?.slice(0, 80)}...`);
  console.log(`Rep: ${repName}`);
  console.log("\nCalling assembleDraft (this triggers the proxy Gemini call)...\n");

  const t0 = Date.now();
  try {
    const result = await assembleDraft(tpl as EmailTemplate, input);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`✅ PASS — assembleDraft completed in ${dt}s`);
    console.log(`\nSubject: ${result.subject}`);
    console.log(`\nIntro output (Gemini): "${result.introOutput.slice(0, 240)}"`);
    console.log(`\nResolved prompt length: ${result.introPromptResolved.length} chars`);
    console.log(`Parts count: ${result.parts.length}`);
    console.log("\nVerified: Gemini-via-proxy path is healthy from server-equivalent runtime.");
  } catch (e) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`❌ FAIL after ${dt}s — ${(e as Error).message}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

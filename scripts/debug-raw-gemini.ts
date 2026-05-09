import { llmChat } from "../src/lib/llm-proxy";
import { supabase } from "../src/lib/db";

async function main() {
  const { data: tpl } = await supabase
    .from("email_templates")
    .select("intro_prompt")
    .eq("name", "global")
    .eq("status", "active")
    .maybeSingle();
  if (!tpl) { console.error("no global"); process.exit(1); }

  const { data: lead } = await supabase
    .from("pipeline_leads")
    .select("title, abstract")
    .ilike("title", "%TemPose%")
    .limit(1)
    .maybeSingle();
  if (!lead) { console.error("no lead"); process.exit(1); }

  const prompt = (tpl.intro_prompt as string)
    .replace("{{title}}", lead.title)
    .replace("{{abstract}}", (lead.abstract ?? "").slice(0, 1000));

  console.log(`Prompt length: ${prompt.length} chars\n`);

  const r = await llmChat({
    model: "gemini-2.5-flash",
    user: prompt,
    temperature: 0.5,
    max_tokens: 1000,
    timeoutMs: 30_000,
  });
  console.log(`RAW gemini output (${r.text.length} chars, finish_reason=${r.meta.finish_reason}):`);
  console.log("---");
  console.log(r.text);
  console.log("---");
  console.log(`tokens_in=${r.meta.tokens_in} tokens_out=${r.meta.tokens_out}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

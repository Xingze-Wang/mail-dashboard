import { llmChat } from "../src/lib/llm-proxy";
import { supabase } from "../src/lib/db";

async function main() {
  const { data: tpl } = await supabase
    .from("email_templates").select("intro_prompt").eq("name", "global").maybeSingle();
  const { data: lead } = await supabase
    .from("pipeline_leads").select("title, abstract").ilike("title", "%TemPose%").limit(1).maybeSingle();
  const prompt = ((tpl as { intro_prompt: string }).intro_prompt)
    .replace("{{title}}", (lead as { title: string }).title)
    .replace("{{abstract}}", ((lead as { abstract: string }).abstract).slice(0, 1000));

  const r = await llmChat({
    model: "gemini-3-flash",
    user: prompt,
    temperature: 0.5,
    max_tokens: 2000,
  });
  console.log(`finish=${r.meta.finish_reason} tokens_in=${r.meta.tokens_in} tokens_out=${r.meta.tokens_out}`);
  console.log(`---\n${r.text}\n---\nlen: ${r.text.length}`);
}
main().catch(console.error);

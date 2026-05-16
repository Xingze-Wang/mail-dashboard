// Diagnose what the first 10 persons look like and whether S2 returns
// anything for them.

import { readFileSync } from "node:fs";

const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const { supabase } = await import("../src/lib/db.ts");
  const { lookupAuthorWithHomepage } = await import("../src/lib/semantic-scholar.ts");

  const { data: persons } = await supabase
    .from("persons")
    .select("id, real_name, arxiv_author_names, emails, homepage, twitter_handle, hf_users, github_users, updated_at")
    .or("homepage.is.null,twitter_handle.is.null")
    .order("updated_at", { ascending: true, nullsFirst: true })
    .limit(10);

  for (const p of persons ?? []) {
    console.log("\n=== person", p.id, "===");
    console.log("  real_name:", p.real_name);
    console.log("  arxiv_names:", p.arxiv_author_names);
    console.log("  emails:", p.emails);
    console.log("  hf_users:", p.hf_users, "github_users:", p.github_users);

    // pull a recent lead for hint
    const { data: lead } = await supabase
      .from("pipeline_leads")
      .select("title, abstract, author_name")
      .eq("person_id", p.id as string)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    console.log("  lead title:", lead?.title?.slice(0, 60));
    console.log("  lead author_name:", lead?.author_name);
    const abstractSnippet = (lead?.abstract as string | undefined)?.slice(0, 200);
    console.log("  abstract head:", abstractSnippet?.slice(0, 100));
    const hfInAbstract = (lead?.abstract as string | undefined)?.match(/huggingface\.co\/[\w-]+/i);
    const ghInAbstract = (lead?.abstract as string | undefined)?.match(/github\.com\/[\w-]+/i);
    console.log("  hf-in-abstract:", hfInAbstract?.[0]);
    console.log("  gh-in-abstract:", ghInAbstract?.[0]);

    const authorName = lead?.author_name || p.real_name || (p.arxiv_author_names as string[])?.[0];
    if (!authorName) {
      console.log("  → no author name to look up");
      continue;
    }
    try {
      const s2 = await lookupAuthorWithHomepage(lead?.title || "", authorName as string);
      console.log("  s2 →", s2 ? { id: s2.authorId, hp: s2.homepage } : null);
    } catch (e) {
      console.log("  s2 → error", String(e).slice(0, 100));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

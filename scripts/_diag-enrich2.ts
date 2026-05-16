// Deep diagnostic on persons-with-leads.
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const { supabase } = await import("../src/lib/db.ts");
  const { lookupAuthorWithHomepage, fetchAuthorHomepage } = await import("../src/lib/semantic-scholar.ts");

  // 5 leads with author_name + person_id
  const { data: leads } = await supabase
    .from("pipeline_leads")
    .select("person_id, author_name, title, abstract, s2_author_id")
    .not("person_id", "is", null)
    .not("author_name", "is", null)
    .order("created_at", { ascending: false })
    .limit(5);

  for (const l of leads ?? []) {
    console.log("\n===", l.author_name, "===");
    console.log("  title:", (l.title as string).slice(0, 80));
    const abs = (l.abstract as string) || "";
    const hfMatch = abs.match(/huggingface\.co\/[\w-]+/i);
    const ghMatch = abs.match(/github\.com\/[\w-]+/i);
    console.log("  hf in abstract:", hfMatch?.[0] || "—");
    console.log("  gh in abstract:", ghMatch?.[0] || "—");
    console.log("  s2_author_id on lead:", l.s2_author_id);

    if (l.s2_author_id) {
      const hp = await fetchAuthorHomepage(l.s2_author_id as string);
      console.log("  S2 homepage (direct via id):", hp);
    }
    try {
      const s2 = await lookupAuthorWithHomepage(l.title as string, l.author_name as string);
      console.log("  S2 full lookup:", s2 ? { id: s2.authorId, hp: s2.homepage } : null);
    } catch (e) {
      console.log("  S2 lookup error:", String(e).slice(0, 100));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

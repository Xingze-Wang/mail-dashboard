import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const { supabase } = await import("../src/lib/db.ts");
  const { enrichPerson } = await import("../src/lib/person-enrichment.ts");

  // Find a lead with github URL in abstract
  const { data: leads } = await supabase
    .from("pipeline_leads")
    .select("person_id, title, abstract, author_name")
    .not("person_id", "is", null)
    .ilike("abstract", "%github.com/%")
    .limit(5);

  for (const l of leads ?? []) {
    console.log("\n===", l.author_name, "===");
    const abs = (l.abstract as string) || "";
    const m = abs.match(/github\.com\/[\w-]+(?:\/[\w-]+)?/);
    console.log("  url snippet:", m?.[0]);
    const r = await enrichPerson({
      person_id: l.person_id as string,
      hint: { title: l.title as string, abstract: abs, author_name: l.author_name as string },
    });
    console.log("  result:", JSON.stringify(r));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

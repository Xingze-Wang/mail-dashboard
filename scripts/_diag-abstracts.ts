import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const { supabase } = await import("../src/lib/db.ts");

  // Pull 100 abstracts and count how many have any project-page-like cue
  const { data: leads } = await supabase
    .from("pipeline_leads")
    .select("title, abstract, author_name")
    .not("abstract", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);

  let hasProjPage = 0;
  let hasHfUrl = 0;
  let hasGhUrl = 0;
  let hasArbitraryUrl = 0;
  const examples: string[] = [];
  for (const l of leads ?? []) {
    const abs = (l.abstract as string) || "";
    if (/(?:project\s*(?:page|website|site)|code\s*(?:is\s*)?available\s*at|website|homepage)/i.test(abs)) {
      hasProjPage++;
      const m = abs.match(/(https?:\/\/[^\s)<>"']+)/);
      if (examples.length < 5 && m) {
        examples.push(`${l.author_name}: ${m[1]}`);
      }
    }
    if (/huggingface\.co\/[\w-]+/i.test(abs)) hasHfUrl++;
    if (/github\.com\/[\w-]+/i.test(abs)) hasGhUrl++;
    if (/https?:\/\/[^\s)<>"']+/.test(abs)) hasArbitraryUrl++;
  }
  console.log(`sample: ${leads?.length}`);
  console.log(`  with project-page cue: ${hasProjPage}`);
  console.log(`  with huggingface.co url: ${hasHfUrl}`);
  console.log(`  with github.com url: ${hasGhUrl}`);
  console.log(`  with ANY url: ${hasArbitraryUrl}`);
  console.log("\nproject-page examples:");
  for (const e of examples) console.log(`  ${e}`);

  // Show a few sample abstracts with urls for pattern-mining
  console.log("\n\nfirst 5 abstracts containing URLs:");
  let shown = 0;
  for (const l of leads ?? []) {
    if (shown >= 5) break;
    const abs = (l.abstract as string) || "";
    const m = abs.match(/(https?:\/\/[^\s)<>"']+)/);
    if (!m) continue;
    shown++;
    const idx = abs.indexOf(m[0]);
    const ctx = abs.slice(Math.max(0, idx - 80), Math.min(abs.length, idx + m[0].length + 20));
    console.log(`  ${l.author_name}: ...${ctx}...`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

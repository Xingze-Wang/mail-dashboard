import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const { supabase } = await import("../src/lib/db.ts");

  const { count: total } = await supabase
    .from("persons")
    .select("id", { count: "exact", head: true });
  console.log("total persons:", total);

  const { count: withName } = await supabase
    .from("persons")
    .select("id", { count: "exact", head: true })
    .not("real_name", "is", null);
  console.log("with real_name:", withName);

  // arxiv_author_names is text[]; check non-empty via "not empty" using rpc-free trick:
  // we can't easily filter array length via supabase-js, so just look at sample
  const { data: sample } = await supabase
    .from("persons")
    .select("id, real_name, arxiv_author_names, emails")
    .limit(200);
  let arxivNamed = 0;
  for (const s of sample ?? []) {
    if (Array.isArray(s.arxiv_author_names) && s.arxiv_author_names.length > 0) arxivNamed++;
  }
  console.log(`from sample of ${sample?.length}, ${arxivNamed} have arxiv_author_names`);

  // How many persons are linked from pipeline_leads?
  const { count: leadLinked } = await supabase
    .from("pipeline_leads")
    .select("person_id", { count: "exact", head: true })
    .not("person_id", "is", null);
  console.log("pipeline_leads rows with person_id set:", leadLinked);

  // Look at FIRST 5 persons that are linked from a lead with a name
  const { data: linked } = await supabase
    .from("pipeline_leads")
    .select("person_id, author_name, title, abstract")
    .not("person_id", "is", null)
    .not("author_name", "is", null)
    .limit(5);
  console.log("first 5 leads with person+author_name:", linked?.map(l => ({ pid: l.person_id, an: l.author_name, t: (l.title as string)?.slice(0,60) })));
}

main().catch((e) => { console.error(e); process.exit(1); });

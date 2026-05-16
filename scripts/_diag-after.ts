import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

async function main() {
  const { supabase } = await import("../src/lib/db.ts");

  // counts
  const { count: totalP } = await supabase.from("persons").select("id", { count: "exact", head: true });
  const { count: hpP } = await supabase.from("persons").select("id", { count: "exact", head: true }).not("homepage", "is", null);
  const { count: twP } = await supabase.from("persons").select("id", { count: "exact", head: true }).not("twitter_handle", "is", null);
  console.log("persons total:", totalP);
  console.log("persons with homepage:", hpP);
  console.log("persons with twitter:", twP);

  // hf_users non-empty count using rpc trick
  const { data: sample } = await supabase
    .from("persons")
    .select("id, hf_users, github_users")
    .limit(2000);
  let hfNonEmpty = 0, ghNonEmpty = 0;
  for (const r of sample ?? []) {
    if (Array.isArray(r.hf_users) && r.hf_users.length > 0) hfNonEmpty++;
    if (Array.isArray(r.github_users) && r.github_users.length > 0) ghNonEmpty++;
  }
  console.log(`from sample of ${sample?.length}: hf_users non-empty=${hfNonEmpty}, github_users non-empty=${ghNonEmpty}`);

  // Show 3 recently-enriched persons
  const { data: recent } = await supabase
    .from("persons")
    .select("id, emails, real_name, homepage, twitter_handle, hf_users, github_users")
    .not("homepage", "is", null)
    .order("updated_at", { ascending: false })
    .limit(3);
  console.log("\nrecent enriched persons:");
  for (const r of recent ?? []) console.log("  ", JSON.stringify(r));

  // How many pipeline_leads with person_id have at least one signal on persons?
  const { data: lpRows } = await supabase
    .from("pipeline_leads")
    .select("id, person_id")
    .not("person_id", "is", null)
    .limit(2000);
  const pids = [...new Set((lpRows ?? []).map((l) => l.person_id as string))];
  console.log(`\ndistinct persons linked from pipeline_leads (sample): ${pids.length}`);
  const { data: enrichedPersons } = await supabase
    .from("persons")
    .select("id, homepage, twitter_handle, hf_users, github_users")
    .in("id", pids.slice(0, 1000));
  let leadsWithAny = 0, leadsWithHp = 0, leadsWithTw = 0, leadsWithHf = 0, leadsWithGh = 0;
  for (const p of enrichedPersons ?? []) {
    let any = false;
    if (p.homepage) { leadsWithHp++; any = true; }
    if (p.twitter_handle) { leadsWithTw++; any = true; }
    if (Array.isArray(p.hf_users) && p.hf_users.length > 0) { leadsWithHf++; any = true; }
    if (Array.isArray(p.github_users) && p.github_users.length > 0) { leadsWithGh++; any = true; }
    if (any) leadsWithAny++;
  }
  console.log(`of ${enrichedPersons?.length} sampled lead-linked persons:`);
  console.log(`  any signal: ${leadsWithAny}`);
  console.log(`  homepage: ${leadsWithHp}, twitter: ${leadsWithTw}, hf: ${leadsWithHf}, github: ${leadsWithGh}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

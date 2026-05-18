// One-shot: roll back the 78 leads with HARD issues to queued so they re-render
import { readFileSync } from "node:fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const audit = JSON.parse(readFileSync("/tmp/draft-audit.json", "utf8"));
const ids = audit.hardLeadIds;
console.log(`rolling back ${ids.length} HARD leads to queued...`);

const BATCH = 50;
let rolled = 0;
for (let i = 0; i < ids.length; i += BATCH) {
  const slice = ids.slice(i, i + BATCH);
  const { data, error } = await sb.from("pipeline_leads")
    .update({ status: "queued" })
    .in("id", slice)
    .eq("status", "ready")
    .select("id");
  if (error) { console.error("err:", error.message); continue; }
  rolled += data?.length ?? 0;
}
console.log(`rolled back ${rolled}/${ids.length}`);

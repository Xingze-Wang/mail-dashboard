import { readFileSync } from "node:fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
console.log(`=== ${new Date().toISOString().slice(11,19)} UTC ===`);
for (const s of ["new", "queued", "drafting", "ready", "sent"]) {
  const { count } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("status", s);
  const { count: assigned } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).eq("status", s).not("assigned_rep_id", "is", null);
  console.log(`  ${s.padEnd(10)} ${count}  (assigned: ${assigned})`);
}

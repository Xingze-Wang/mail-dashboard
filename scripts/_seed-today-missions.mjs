// Manually fire the same logic as the seed cron: pull each rep's quota,
// insert a kind=send mission for today with the per_pool scope.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const today = new Date().toISOString().slice(0, 10);
const { data: quotas } = await sb.from("rep_daily_quotas").select("*");
console.log(`Found ${quotas?.length || 0} quotas`);

for (const q of quotas || []) {
  const pp = q.per_pool || {};
  const sendTarget = (pp.strong || 0) + (pp.normal_cn || 0) + (pp.normal_overseas || 0) + (pp.normal_edu || 0);
  if (sendTarget <= 0) {
    console.log(` rep=${q.rep_id} skip: zero quota`);
    continue;
  }
  // Idempotency: skip if mission already exists
  const { data: existing } = await sb
    .from("missions")
    .select("id")
    .eq("rep_id", q.rep_id)
    .eq("due_date", today)
    .eq("kind", "send");
  if (existing && existing.length > 0) {
    console.log(` rep=${q.rep_id} skip: already has send mission today`);
    continue;
  }
  const breakdown = Object.entries(pp).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(", ");
  const { error } = await sb.from("missions").insert({
    rep_id: q.rep_id,
    due_date: today,
    kind: "send",
    target: sendTarget,
    description: `今天的目标: 发 ${sendTarget} 封 (${breakdown}). 早上 9 点系统会自动分配到你 queue.`,
    generated_by: "heuristic",
    status: "active",
    scope: { per_pool: pp, direction_priority: q.direction_priority || [] },
  });
  if (error) console.log(` rep=${q.rep_id} ERR ${error.message}`);
  else console.log(` rep=${q.rep_id} inserted send-mission target=${sendTarget} (${breakdown})`);
}

import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient("https://erguqrisqtugfysofwdd.supabase.co","eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",{auth:{persistSession:false}});

const today = new Date().toISOString().slice(0,10);
const { data: reps } = await sb.from("sales_reps").select("id, name").eq("active", true).eq("role", "sales");
console.log("Active sales reps:", (reps||[]).map(r=>r.name).join(","));

for (const r of reps || []) {
  const { data: existing } = await sb.from("missions").select("id").eq("rep_id", r.id).eq("due_date", today).limit(1);
  if (existing?.length) { console.log(" ", r.name, "already has missions, skip"); continue; }
  const { count: ready } = await sb.from("pipeline_leads").select("id",{count:"exact",head:true}).eq("assigned_rep_id", r.id).eq("status", "ready");
  const sendTarget = Math.max(5, Math.min(12, ready ?? 5));
  const rows = [{ rep_id: r.id, due_date: today, kind: "send", target: sendTarget, description: `今天的目标: 发 ${sendTarget} 封 (基于你 ready 队列里的数量算出来的, 5-12 区间).`, generated_by: "heuristic", status: "active" }];
  const { error } = await sb.from("missions").insert(rows);
  console.log(" ", r.name, "send=", sendTarget, error?error.message:"OK");
}

import { readFileSync } from "node:fs";
const envFile = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const { computeInsightsPayload } = await import("/Users/xingzewang/Desktop/mail/src/app/api/insights/route.ts");
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const today = new Date().toISOString().slice(0, 10);
const { data: reps } = await sb.from("sales_reps").select("id, name, role, active").eq("active", true);
console.log("Active reps:", (reps || []).length);

async function upsert(repIdNullable, viewAs, payload) {
  let q = sb.from("insights_llm_cache").select("id").eq("role_view", viewAs).eq("effective_date", today);
  q = repIdNullable === null ? q.is("rep_id", null) : q.eq("rep_id", repIdNullable);
  const { data: hit } = await q.maybeSingle();
  if (hit) {
    await sb.from("insights_llm_cache").update({ payload, computed_at: new Date().toISOString(), decided_by: "cron", decision_model: "claude-sonnet-4.6" }).eq("id", hit.id);
  } else {
    await sb.from("insights_llm_cache").insert({ rep_id: repIdNullable, role_view: viewAs, payload, decided_by: "cron", decision_model: "claude-sonnet-4.6", effective_date: today });
  }
}

const firstAdmin = (reps || []).find((r) => r.role === "admin");
if (firstAdmin) {
  console.log("Org-wide admin view via", firstAdmin.name);
  const t0 = Date.now();
  try {
    const p = await computeInsightsPayload({ repId: firstAdmin.id, repName: firstAdmin.name, role: "admin" });
    await upsert(null, "admin", p);
    console.log("  org admin OK,", ((Date.now()-t0)/1000).toFixed(1), "s, cards=", p.cards.length);
  } catch (e) {
    console.log("  org admin FAIL:", String(e).slice(0, 200));
  }
}

for (const r of reps || []) {
  const t0 = Date.now();
  try {
    const p = await computeInsightsPayload({ repId: r.id, repName: r.name, role: r.role });
    const viewAs = r.role === "admin" ? "admin" : "rep";
    await upsert(r.id, viewAs, p);
    console.log("  rep", r.id, r.name, viewAs, "OK,", ((Date.now()-t0)/1000).toFixed(1), "s, cards=", p.cards.length);
  } catch (e) {
    console.log("  rep", r.id, r.name, "FAIL:", String(e).slice(0, 200));
  }
}
console.log("DONE");

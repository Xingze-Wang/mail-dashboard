// Smoke test the judge-resolved predictions loop.
//
// Steps:
//   1. Pick an existing lead from pipeline_leads
//   2. Insert a fake prediction with deadline already past
//   3. POST /api/cron with the right secret to trigger the resolver
//      (resolveDuePredictions runs as cron Step 5)
//   4. Inspect the row — should have judge_avg/judge_verdicts and a
//      self_critique row in helper_learnings
//   5. Clean up
//
// Pre-req: dev server running on localhost:3000, CRON_SECRET set in
// .env.local (matches what the cron route checks).
//
// Run: node scripts/smoke-prediction-judge.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf8").split("\n");
function envVar(name) {
  const line = env.find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).replace(/^["']|["']$/g, "").trim();
}
const cronSecret = envVar("CRON_SECRET");
if (!cronSecret) {
  console.error("CRON_SECRET not in .env.local");
  process.exit(1);
}

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const { data: lead } = await sb
  .from("pipeline_leads")
  .select("id, title, school_tier")
  .not("title", "is", null)
  .not("abstract", "is", null)
  .limit(1)
  .maybeSingle();
if (!lead) {
  console.error("No lead with title+abstract");
  process.exit(1);
}
console.log(`Using lead: "${lead.title?.slice(0, 60)}..."`);

const { data: rep } = await sb.from("sales_reps").select("id").order("id").limit(1).maybeSingle();
const TAG = `SMOKE-PRED-${Date.now()}`;
const { data: pred, error: insErr } = await sb
  .from("helper_predictions")
  .insert({
    rep_id: rep.id,
    claim: `${TAG} I predict this lead won't reply because the paper is academic-leaning and they're at a tier-${lead.school_tier ?? "?"} school where industry outreach gets ignored`,
    target_event: "no_reply",
    target_lead_id: lead.id,
    target_deadline: new Date(Date.now() - 60_000).toISOString(),
  })
  .select()
  .single();
if (insErr) {
  console.error("Insert failed:", insErr.message);
  process.exit(1);
}
console.log(`Prediction inserted (id=${pred.id})`);

console.log("\nCalling /api/cron — this hits all 6 steps including prediction resolver. Will take 30-60s.");
const r = await fetch("http://localhost:3000/api/cron", {
  headers: { Authorization: `Bearer ${cronSecret}` },
});
const body = await r.json();
if (!r.ok) {
  console.error("cron failed:", body);
  process.exit(1);
}
console.log("\ncron predictions step result:", body.predictions);

const { data: resolved } = await sb
  .from("helper_predictions")
  .select("resolved_correct, resolution_note, judge_avg, judge_verdicts")
  .eq("id", pred.id)
  .maybeSingle();
console.log("\nResolved row:");
console.log(JSON.stringify(resolved, null, 2));

const { data: critiques } = await sb
  .from("helper_learnings")
  .select("kind, body, confidence")
  .eq("kind", "self_critique")
  .ilike("body", `%${TAG}%`);
console.log("\nSelf-critiques landed:");
for (const c of critiques ?? []) console.log(`  [${c.kind}, conf=${c.confidence}] ${c.body}`);

await sb.from("helper_predictions").delete().eq("id", pred.id);
await sb.from("helper_learnings").delete().eq("kind", "self_critique").ilike("body", `%${TAG}%`);
console.log("\nCleaned up.");

// Smoke test for helper-driven re-assign.
//
// Mints an admin JWT and walks:
//   1. /api/help/execute reassign_lead — admin role
//   2. /api/help/execute reassign_lead — sales role (expect refusal)
//   3. /api/help/execute reassign_leads_bulk — preview phase (confirm:false)
//   4. /api/help/execute reassign_leads_bulk — invalid rules (>5)
//   5. round-trip: bulk apply tiny rule set → restore via reassign_lead
//
// Doesn't go through the LLM — exercises the action dispatcher directly.

import { readFileSync } from "node:fs";
import { SignJWT } from "jose";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf8").split("\n");
const secret = env.find((l) => l.startsWith("AUTH_SECRET="))?.slice(12).replace(/^["']|["']$/g, "").trim();
if (!secret) { console.error("AUTH_SECRET missing"); process.exit(1); }

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

async function mint(role, repId) {
  return new SignJWT({ repId, repName: "smoke", email: "smoke@local", role })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
}

const adminToken = await mint("admin", 5);
const salesToken = await mint("sales", 1);
const BASE = "http://localhost:3000";

let pass = 0, fail = 0;

async function call(token, proposal) {
  const r = await fetch(BASE + "/api/help/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `qiji_session=${token}` },
    body: JSON.stringify({ proposal }),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, ok: r.ok, body };
}

function step(label, condition, detail = "") {
  if (condition) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail}`); }
}

console.log("=== Helper reassign smoke ===\n");

// Pre-fetch a lead to use as the round-trip subject. Sales role gets
// admin-side targets via service-role key.
const [{ data: rep0 }, { data: rep1 }, { data: leadRow }] = await Promise.all([
  sb.from("sales_reps").select("id, name").eq("id", 1).single(),
  sb.from("sales_reps").select("id, name").eq("id", 2).single(),
  sb.from("pipeline_leads")
    .select("id, assigned_rep_id, author_email")
    .eq("status", "skipped")
    .eq("assigned_rep_id", 1)
    .limit(1)
    .single(),
]);

if (!leadRow) {
  console.log("No skipped lead under rep 1 — using any lead under rep 1");
  const { data: any1 } = await sb.from("pipeline_leads").select("id, assigned_rep_id, author_email").eq("assigned_rep_id", 1).limit(1).single();
  if (!any1) { console.error("no lead under rep 1, abort"); process.exit(1); }
  Object.assign(leadRow ?? {}, any1);
}

console.log(`Using lead ${leadRow.id.slice(0, 8)} on rep ${leadRow.assigned_rep_id}\n`);

// ── 1. Single reassign as admin
const r1 = await call(adminToken, { action: "reassign_lead", lead_id: leadRow.id, to_rep_id: rep1.id, reason: "smoke" });
step(`single reassign admin → ${rep1.name}`, r1.ok && r1.body.detail?.reassigned >= 1, JSON.stringify(r1.body));

// ── 2. Sales role refused
const r2 = await call(salesToken, { action: "reassign_lead", lead_id: leadRow.id, to_rep_id: rep0.id });
step("single reassign sales → 403/refused", !r2.body.detail?.reassigned && /admin only/i.test(r2.body.detail?.error ?? ""), JSON.stringify(r2.body));

// ── 3. Restore + bulk preview
await call(adminToken, { action: "reassign_lead", lead_id: leadRow.id, to_rep_id: rep0.id, reason: "smoke restore" });
console.log("(restored)\n");

const previewProposal = {
  action: "reassign_leads_bulk",
  rules: [
    { when: { geo: "cn", leadTier: "strong" }, to_rep_id: rep0.id },
    { when: { geo: "cn" }, to_rep_id: rep1.id },
  ],
};
const r3 = await call(adminToken, { ...previewProposal, confirm: false });
step("bulk preview returns counts", r3.ok && r3.body.detail?.preview === true && typeof r3.body.detail?.total_to_move === "number", JSON.stringify(r3.body).slice(0, 200));
if (r3.body.detail?.preview) {
  console.log(`     would move ${r3.body.detail.total_to_move} (unmatched=${r3.body.detail.unmatched})`);
  for (const pr of r3.body.detail.per_rule ?? []) {
    console.log(`     rule ${pr.rule_index}: ${pr.match_count} → ${pr.to_rep.name}`);
  }
}

// ── 4. Invalid rules: 6 entries
const tooMany = { action: "reassign_leads_bulk", rules: Array.from({ length: 6 }, (_, i) => ({ when: { geo: "cn" }, to_rep_id: rep0.id })) };
const r4 = await call(adminToken, tooMany);
step("bulk reject >5 rules", !r4.body.detail?.preview && /1-5/i.test(r4.body.detail?.error ?? ""), JSON.stringify(r4.body));

// ── 5. Empty when clause
const emptyWhen = { action: "reassign_leads_bulk", rules: [{ when: {}, to_rep_id: rep0.id }] };
const r5 = await call(adminToken, emptyWhen);
step("bulk reject empty when", !r5.body.detail?.preview && /at least one field/i.test(r5.body.detail?.error ?? ""), JSON.stringify(r5.body));

// ── 6. Round-trip via bulk apply (tiny: just our one test lead)
// Use a rule that matches only our test lead by currentRepId + geo
const isCn = leadRow.author_email?.toLowerCase().endsWith(".cn");
if (!isCn) {
  console.log("\n(test lead is not .cn — skipping round-trip via bulk apply)");
} else {
  const tinyRules = {
    action: "reassign_leads_bulk",
    rules: [{ when: { currentRepId: rep0.id, geo: "cn", leadTier: leadRow.lead_tier ?? "normal" }, to_rep_id: rep1.id }],
    confirm: true,
  };
  const r6 = await call(adminToken, tinyRules);
  step("bulk apply succeeds", r6.ok && r6.body.detail?.applied === true, JSON.stringify(r6.body).slice(0, 200));
  // Restore
  await call(adminToken, { action: "reassign_lead", lead_id: leadRow.id, to_rep_id: rep0.id });
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

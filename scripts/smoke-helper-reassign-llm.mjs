// End-to-end LLM smoke for the new helper reassign tools.
//
// Hits /api/help/ask with real prompts as both admin and sales,
// inspects the resulting tool_proposal, then exercises the
// preview-then-apply flow. The /api/help/execute calls are skipped
// for the apply phase by default to avoid moving prod data — set
// APPLY=1 to run a real round-trip.
//
// Run: node scripts/smoke-helper-reassign-llm.mjs [APPLY=1]

import { readFileSync } from "node:fs";
import { SignJWT } from "jose";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync(".env.local", "utf8").split("\n");
const secret = env.find((l) => l.startsWith("AUTH_SECRET="))?.slice(12).replace(/^["']|["']$/g, "").trim();
if (!secret) { console.error("AUTH_SECRET missing"); process.exit(1); }
const APPLY = process.env.APPLY === "1";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

async function mintCookie(role, repId) {
  const t = await new SignJWT({ repId, repName: role === "admin" ? "Xingze" : "Leo", email: `${role}@local`, role })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
  return `qiji_session=${t}`;
}
const adminCookie = await mintCookie("admin", 5);
const salesCookie = await mintCookie("sales", 1);
const BASE = "http://localhost:3000";

let pass = 0, fail = 0;
function step(label, ok, detail = "") {
  if (ok) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}\n      ${detail}`); }
}

async function ask(cookie, question, conversationId = null) {
  const r = await fetch(BASE + "/api/help/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ question, conversationId }),
  });
  return await r.json();
}
async function exec(cookie, proposal) {
  const r = await fetch(BASE + "/api/help/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ proposal }),
  });
  return await r.json();
}

console.log("=== Helper LLM end-to-end smoke ===\n");

// Pre-fetch a real lead we can name, plus the test reps.
const { data: rep1 } = await sb.from("sales_reps").select("id, name").eq("id", 1).single();
const { data: rep2 } = await sb.from("sales_reps").select("id, name").eq("id", 2).single();
const { data: testLead } = await sb
  .from("pipeline_leads")
  .select("id, author_name, title, assigned_rep_id, lead_tier, author_email")
  .eq("status", "ready")
  .eq("assigned_rep_id", 1)
  .not("author_name", "is", null)
  .limit(1)
  .single();
console.log(`reps: ${rep1.name}(${rep1.id}) vs ${rep2.name}(${rep2.id})`);
console.log(`test lead: ${testLead?.author_name} — ${testLead?.title?.slice(0, 60)} (currently rep ${testLead?.assigned_rep_id})\n`);

// ── 1. Admin: single reassign by name
console.log("── Test 1: admin says 'move <name>'s lead to <rep2>'");
const r1 = await ask(adminCookie, `把 ${testLead.author_name} 的 lead 重新指派给 ${rep2.name}`);
const p1 = r1.proposal;
console.log(`     model: ${r1.model}`);
console.log(`     proposal: ${JSON.stringify(p1)}`);
console.log(`     answer: ${(r1.answer ?? "").slice(0, 200)}`);
step(
  "1. admin reassign — proposed reassign_lead",
  p1?.action === "reassign_lead" && p1.lead_id === testLead.id && p1.to_rep_id === rep2.id,
  `proposal=${JSON.stringify(p1)}`,
);

// ── 2. Admin: rules-based bulk move
console.log("\n── Test 2: admin says 'rules: .cn strong → Leo, .edu → Chenyu'");
const r2 = await ask(adminCookie, `给我设两条规则: .cn 的 strong lead 全给 ${rep1.name}, .edu 的全给 ${rep2.name}`);
console.log(`     proposal: ${JSON.stringify(r2.proposal)}`);
console.log(`     answer: ${(r2.answer ?? "").slice(0, 200)}`);
const p2 = r2.proposal;
const okShape = p2?.action === "reassign_leads_bulk" && Array.isArray(p2.rules) && p2.rules.length === 2;
let rulesLookRight = false;
if (okShape) {
  const cnStrong = p2.rules.find((r) => r.when?.geo === "cn" && r.when?.leadTier === "strong");
  const edu = p2.rules.find((r) => r.when?.geo === "edu");
  rulesLookRight = !!cnStrong && !!edu && cnStrong.to_rep_id === rep1.id && edu.to_rep_id === rep2.id;
}
step("2. admin bulk rules — proposed reassign_leads_bulk with right rules", rulesLookRight, JSON.stringify(p2));

// Verify preview from server actually runs (without applying)
if (okShape) {
  const prev = await exec(adminCookie, { ...p2, confirm: false });
  console.log(`     preview: total_to_move=${prev.detail?.total_to_move}, unmatched=${prev.detail?.unmatched}`);
  step(
    "2b. preview returned counts",
    prev.ok && prev.detail?.preview === true && typeof prev.detail.total_to_move === "number",
    JSON.stringify(prev).slice(0, 200),
  );

  // Cross-check preview count against direct DB query. Mirrors the
  // server: first-rule-wins + skip-no-ops (lead already on target).
  const { data: leads } = await sb.from("pipeline_leads").select("author_email, lead_tier, assigned_rep_id").limit(5000);
  let expected = 0;
  for (const l of leads ?? []) {
    const e = (l.author_email ?? "").toLowerCase();
    const isCn = e.endsWith(".cn");
    const isEdu = e.endsWith(".edu") || e.endsWith(".edu.cn");
    // Rule 0 wins for cn+strong; Rule 1 catches remaining edu.
    if (isCn && l.lead_tier === "strong") {
      if (l.assigned_rep_id !== rep1.id) expected++;
    } else if (isEdu) {
      if (l.assigned_rep_id !== rep2.id) expected++;
    }
  }
  step(
    "2c. preview count matches independent DB count",
    prev.detail?.total_to_move === expected,
    `server=${prev.detail?.total_to_move} db=${expected}`,
  );
}

// ── 3. Admin: data-model question (verify prompt drilled it correctly)
console.log("\n── Test 3: admin asks 'what about old send history?'");
const r3 = await ask(
  adminCookie,
  "如果我把这个 lead 重新指派给另一个 rep, 之前的发件历史还算原来那个人发的吗?",
);
const ans3 = (r3.answer ?? "").toLowerCase();
const mentionsActor = /actor|历史|不变|原来.*发|previous|history/i.test(r3.answer ?? "");
const mentionsOwner = /owner|所有|inbox|收件|new rep|新.*rep/i.test(r3.answer ?? "");
console.log(`     answer (first 300 chars): ${(r3.answer ?? "").slice(0, 300)}`);
step(
  "3. admin data-model question — answer mentions actor stays + owner changes",
  mentionsActor && mentionsOwner,
  `mentionsActor=${mentionsActor} mentionsOwner=${mentionsOwner}`,
);

// ── 4. Sales: same single reassign → either helper refuses or execute returns admin-only
console.log("\n── Test 4: sales says 'move <name>'s lead to <rep2>'");
const r4 = await ask(salesCookie, `把 ${testLead.author_name} 的 lead 重新指派给 ${rep2.name}`);
console.log(`     proposal: ${JSON.stringify(r4.proposal)}`);
console.log(`     answer: ${(r4.answer ?? "").slice(0, 200)}`);
let salesPath;
if (r4.proposal?.action === "reassign_lead") {
  // Helper proposed; server should refuse on execute.
  const ex = await exec(salesCookie, r4.proposal);
  salesPath = `proposal+execute: ${JSON.stringify(ex).slice(0, 200)}`;
  step(
    "4. sales reassign — execute refused with admin-only",
    ex.ok === false && /admin only/i.test(ex.detail?.error ?? ""),
    salesPath,
  );
} else {
  // Helper itself refused (also acceptable — depends on prompt steer).
  step(
    "4. sales reassign — helper declined to propose",
    !r4.proposal,
    `proposal=${JSON.stringify(r4.proposal)}`,
  );
}

// ── 5. 7-rule proposal at the API layer — validator must reject.
console.log("\n── Test 5: 7-rule proposal hits /execute → expect rejection");
const sevenRules = {
  action: "reassign_leads_bulk",
  rules: Array.from({ length: 7 }, (_, i) => ({ when: { geo: i % 2 ? "cn" : "edu" }, to_rep_id: rep1.id })),
};
const r5api = await fetch(BASE + "/api/help/execute", {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: adminCookie },
  body: JSON.stringify({ proposal: sevenRules }),
}).then((r) => r.json());
step(
  "5. 7-rule proposal rejected at /execute layer",
  r5api.ok === false && /1-5/i.test(r5api.detail?.error ?? ""),
  JSON.stringify(r5api),
);

// ── 6 (optional): real round-trip apply
if (APPLY && testLead && rep2) {
  console.log("\n── Test 6: APPLY=1 — round-trip a single lead via helper proposal");
  const ex1 = await exec(adminCookie, { action: "reassign_lead", lead_id: testLead.id, to_rep_id: rep2.id, reason: "smoke" });
  step("6. round-trip move", ex1.ok && ex1.detail?.reassigned >= 1, JSON.stringify(ex1));
  // restore
  await exec(adminCookie, { action: "reassign_lead", lead_id: testLead.id, to_rep_id: testLead.assigned_rep_id });
  console.log("     restored");
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

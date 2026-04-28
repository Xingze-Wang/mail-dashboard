// Adversarial smoke for the reassign system. Each test name maps to
// a row in the threat model — see the conversation that produced
// this script.
//
// Categories: A = auth, V = validation, C = cascade, S = semantics.
// R (race) and U (undo) are not exercised — race needs concurrency,
// undo isn't implemented.
//
// Run: node scripts/smoke-reassign-adversarial.mjs

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

async function mint(role, repId, expiresIn = "1h") {
  return new SignJWT({ repId, repName: "smoke", email: `${role}@local`, role })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
}

const adminCookie = `qiji_session=${await mint("admin", 5)}`;
const salesCookie = `qiji_session=${await mint("sales", 1)}`;
const expiredAdminCookie = `qiji_session=${await mint("admin", 5, "-1h")}`;
const noCookie = "";
const BASE = "http://localhost:3000";

let pass = 0, fail = 0;
const fails = [];
function step(label, ok, detail = "") {
  if (ok) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}\n      ${detail}`); fails.push({ label, detail }); }
}

async function call(path, init = {}) {
  const r = await fetch(BASE + path, init);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, ok: r.ok, body };
}

console.log("=== Adversarial reassign smoke ===\n");

// Pre-fetch fixtures
const { data: rep1 } = await sb.from("sales_reps").select("id, name").eq("id", 1).single();
const { data: rep2 } = await sb.from("sales_reps").select("id, name").eq("id", 2).single();
const { data: testLead } = await sb
  .from("pipeline_leads")
  .select("id, assigned_rep_id, thread_id, status")
  .eq("status", "skipped")
  .eq("assigned_rep_id", 1)
  .limit(1)
  .single();
const NONEXISTENT_REP_ID = 99999;

console.log(`reps: ${rep1.name}(1) ${rep2.name}(2); test lead: ${testLead.id.slice(0, 8)} thread=${testLead.thread_id ? "Y" : "N"}\n`);

// ── Category A: Authorization ────────────────────────────────────
console.log("── A: Authorization\n");

// A1. Sales hits /api/admin/reassign-leads directly
{
  const r = await call("/api/admin/reassign-leads", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: salesCookie },
    body: JSON.stringify({ mode: "preview", toRepId: rep2.id, filter: { currentRepId: rep1.id } }),
  });
  step("A1. sales blocked from /api/admin/reassign-leads", r.status === 403 || r.status === 401, `status=${r.status} body=${JSON.stringify(r.body).slice(0, 120)}`);
}

// A2. Sales hits /api/help/execute with admin-only action
{
  const r = await call("/api/help/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: salesCookie },
    body: JSON.stringify({ proposal: { action: "reassign_lead", lead_id: testLead.id, to_rep_id: rep2.id } }),
  });
  step("A2. sales /execute reassign refused at handler",
    r.body.ok === false && /admin only/i.test(r.body.detail?.error ?? ""),
    JSON.stringify(r.body).slice(0, 200));
}

// A3. Same on bulk
{
  const r = await call("/api/help/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: salesCookie },
    body: JSON.stringify({ proposal: { action: "reassign_leads_bulk", rules: [{ when: { geo: "cn" }, to_rep_id: 1 }] } }),
  });
  step("A3. sales /execute bulk refused", r.body.ok === false && /admin only/i.test(r.body.detail?.error ?? ""),
    JSON.stringify(r.body).slice(0, 200));
}

// A4. Expired token
{
  const r = await call("/api/admin/reassign-leads", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: expiredAdminCookie },
    body: JSON.stringify({ mode: "preview", toRepId: rep2.id, filter: {} }),
  });
  step("A4. expired admin token rejected", r.status === 401 || r.status === 403, `status=${r.status}`);
}

// A5. No cookie at all
{
  const r = await call("/api/admin/reassign-leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "preview", toRepId: rep2.id, filter: {} }),
  });
  step("A5. no cookie rejected", r.status === 401, `status=${r.status}`);
}

// A6. PATCH /api/pipeline/[id] as sales — attempt to set assignedRepId
// Should silently drop the assignedRepId field (admin-only)
{
  const r = await call(`/api/pipeline/${testLead.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: salesCookie },
    body: JSON.stringify({ assignedRepId: rep2.id }),
  });
  // We don't expect 403 here — sales can PATCH their own lead, just
  // not the assignedRepId field. Confirm the lead's rep didn't change.
  const { data: after } = await sb.from("pipeline_leads").select("assigned_rep_id").eq("id", testLead.id).single();
  step("A6. sales PATCH silently drops assignedRepId",
    after.assigned_rep_id === testLead.assigned_rep_id,
    `before=${testLead.assigned_rep_id} after=${after.assigned_rep_id} status=${r.status}`);
}

// ── Category V: Validation ──────────────────────────────────────
console.log("\n── V: Validation\n");

// V1. Nonexistent rep
{
  const r = await call("/api/help/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ proposal: { action: "reassign_lead", lead_id: testLead.id, to_rep_id: NONEXISTENT_REP_ID } }),
  });
  step("V1. nonexistent target rep rejected before write",
    r.body.ok === false && /not found/i.test(r.body.detail?.error ?? ""),
    JSON.stringify(r.body).slice(0, 200));
  // Confirm the lead wasn't actually moved
  const { data: lead } = await sb.from("pipeline_leads").select("assigned_rep_id").eq("id", testLead.id).single();
  step("V1b. lead.assigned_rep_id unchanged after V1", lead.assigned_rep_id === testLead.assigned_rep_id,
    `was=${testLead.assigned_rep_id} now=${lead.assigned_rep_id}`);
}

// V2. to_rep_id = -1
{
  const r = await call("/api/help/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ proposal: { action: "reassign_lead", lead_id: testLead.id, to_rep_id: -1 } }),
  });
  step("V2. negative to_rep_id rejected",
    r.body.ok === false && /not found/i.test(r.body.detail?.error ?? ""),
    JSON.stringify(r.body).slice(0, 200));
}

// V3. Rule with non-numeric currentRepId
{
  const r = await call("/api/help/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ proposal: { action: "reassign_leads_bulk", rules: [{ when: { currentRepId: "Leo" }, to_rep_id: rep1.id }] } }),
  });
  step("V3. string currentRepId rejected",
    r.body.ok === false && /currentRepId must be a number/i.test(r.body.detail?.error ?? ""),
    JSON.stringify(r.body).slice(0, 200));
}

// V4. Garbage extra keys in `when` should be ignored, not error
{
  const r = await call("/api/help/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: adminCookie },
    body: JSON.stringify({
      proposal: {
        action: "reassign_leads_bulk",
        rules: [{ when: { geo: "cn", randomCrap: "yes", anotherJunk: 42 }, to_rep_id: rep1.id }],
        confirm: false,
      },
    }),
  });
  step("V4. unknown when keys ignored (not rejected)",
    r.body.ok === true && r.body.detail?.preview === true,
    JSON.stringify(r.body).slice(0, 200));
}

// V5. Missing to_rep_id (undefined)
{
  const r = await call("/api/help/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ proposal: { action: "reassign_leads_bulk", rules: [{ when: { geo: "cn" } }] } }),
  });
  step("V5. missing to_rep_id rejected",
    r.body.ok === false && /to_rep_id required/i.test(r.body.detail?.error ?? ""),
    JSON.stringify(r.body).slice(0, 200));
}

// V6. SQL-injection in reason — should be parameterized + safely stored
{
  const inject = "'); DROP TABLE pipeline_leads; --";
  const r = await call("/api/help/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ proposal: { action: "reassign_lead", lead_id: testLead.id, to_rep_id: testLead.assigned_rep_id, reason: inject } }),
  });
  // Self-no-op so no actual move. Verify the table still exists by
  // running a count query that would 404 if the table were gone.
  const { count } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true });
  step("V6. SQL-injection-shaped reason doesn't break DB",
    r.body.ok === true && typeof count === "number" && count > 100,
    `body=${JSON.stringify(r.body).slice(0, 200)} table-count=${count}`);
}

// V7. Orphan-thread aliasing: if two unrelated leads share the SAME
// thread_id (shouldn't happen in production, but DB schema doesn't
// prevent it), cascade for one bleeds onto emails for the other.
// We confirm by inspecting whether reassign_lead can scoop emails
// belonging to another lead — that's a real data-integrity issue.
{
  const { data: alias } = await sb
    .from("pipeline_leads")
    .select("thread_id")
    .not("thread_id", "is", null);
  // Group by thread_id, find any that have >1 lead
  const counts = new Map();
  for (const l of alias ?? []) counts.set(l.thread_id, (counts.get(l.thread_id) ?? 0) + 1);
  const orphans = [...counts.entries()].filter(([, c]) => c > 1);
  if (orphans.length === 0) {
    console.log("V7. SKIP — no thread_id is shared across multiple leads (good!)");
  } else {
    console.log(`V7. WARN — ${orphans.length} thread_ids are shared across multiple leads. Sample: ${orphans[0][0]}`);
    step("V7. WARN: thread_id sharing exists — cascade may bleed",
      false,
      `${orphans.length} threads have multiple leads. cascade by thread_id will move emails for all of them.`);
  }
}

// ── Category C: Cascade ──────────────────────────────────────────
console.log("\n── C: Cascade\n");

// C1. Lead with thread_id=null — cascade should be no-op, update should still work
{
  const { data: noThread } = await sb
    .from("pipeline_leads")
    .select("id, assigned_rep_id, thread_id")
    .is("thread_id", null)
    .limit(1)
    .single();
  if (!noThread) {
    console.log("C1. SKIP — no lead with thread_id=null");
  } else {
    const original = noThread.assigned_rep_id;
    const target = original === rep1.id ? rep2.id : rep1.id;
    const r = await call("/api/help/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ proposal: { action: "reassign_lead", lead_id: noThread.id, to_rep_id: target } }),
    });
    step("C1. lead with no thread_id moves cleanly",
      r.body.ok === true && r.body.detail?.reassigned === 1 && r.body.detail?.emailsCascaded === 0,
      JSON.stringify(r.body).slice(0, 200));
    // Restore
    await call("/api/help/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ proposal: { action: "reassign_lead", lead_id: noThread.id, to_rep_id: original } }),
    });
  }
}

// C2. actor_rep_id stays untouched after cascade
{
  // Find a lead with at least one email row that has a non-null actor_rep_id
  const { data: leadWithActor } = await sb
    .from("pipeline_leads")
    .select("id, assigned_rep_id, thread_id")
    .not("thread_id", "is", null)
    .not("assigned_rep_id", "is", null)
    .limit(1)
    .single();
  if (!leadWithActor) {
    console.log("C2. SKIP — no qualifying lead");
  } else {
    const { data: emailsBefore } = await sb
      .from("emails")
      .select("id, rep_id, actor_rep_id")
      .eq("thread_id", leadWithActor.thread_id);
    const actorsBefore = (emailsBefore ?? []).map((e) => e.actor_rep_id);
    const target = leadWithActor.assigned_rep_id === rep1.id ? rep2.id : rep1.id;
    await call("/api/help/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ proposal: { action: "reassign_lead", lead_id: leadWithActor.id, to_rep_id: target } }),
    });
    const { data: emailsAfter } = await sb
      .from("emails")
      .select("id, rep_id, actor_rep_id")
      .eq("thread_id", leadWithActor.thread_id);
    const actorsAfter = (emailsAfter ?? []).map((e) => e.actor_rep_id);
    const actorPreserved = JSON.stringify(actorsBefore.sort()) === JSON.stringify(actorsAfter.sort());
    const repsCascaded = (emailsAfter ?? []).every((e) => e.rep_id === target);
    step("C2. actor_rep_id preserved through cascade", actorPreserved,
      `before=${JSON.stringify(actorsBefore)} after=${JSON.stringify(actorsAfter)}`);
    step("C2b. rep_id cascaded to ALL emails on thread", repsCascaded,
      `target=${target} got=${JSON.stringify((emailsAfter ?? []).map((e) => e.rep_id))}`);
    // Restore
    await call("/api/help/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ proposal: { action: "reassign_lead", lead_id: leadWithActor.id, to_rep_id: leadWithActor.assigned_rep_id } }),
    });
  }
}

// ── Category S: Semantics ───────────────────────────────────────
console.log("\n── S: Semantics\n");

// S1. First-rule-wins: rule 1 broad, rule 2 narrower. Rule 2 should
// match nothing because rule 1 caught everything first.
{
  const r = await call("/api/help/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: adminCookie },
    body: JSON.stringify({
      proposal: {
        action: "reassign_leads_bulk",
        rules: [
          { when: { geo: "cn" }, to_rep_id: rep1.id },
          { when: { geo: "cn", leadTier: "strong" }, to_rep_id: rep2.id },
        ],
        confirm: false,
      },
    }),
  });
  const r2 = (r.body.detail?.per_rule ?? []).find((p) => p.rule_index === 1);
  step("S1. first-rule-wins: narrower rule 2 starves",
    r.body.ok === true && r2?.match_count === 0,
    `rule2 matchCount=${r2?.match_count}`);
}

// S2. Rule with currentRepId == to_rep_id (no-op rule)
{
  const r = await call("/api/help/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: adminCookie },
    body: JSON.stringify({
      proposal: {
        action: "reassign_leads_bulk",
        rules: [{ when: { currentRepId: rep1.id }, to_rep_id: rep1.id }],
        confirm: false,
      },
    }),
  });
  step("S2. rule that's already-applied → 0 moves",
    r.body.ok === true && r.body.detail?.total_to_move === 0,
    `total_to_move=${r.body.detail?.total_to_move}`);
}

// S3. currentRepId: null filters correctly
{
  const r = await call("/api/help/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: adminCookie },
    body: JSON.stringify({
      proposal: {
        action: "reassign_leads_bulk",
        rules: [{ when: { currentRepId: null }, to_rep_id: rep1.id }],
        confirm: false,
      },
    }),
  });
  // Cross-check: count of unassigned leads
  const { count: unassigned } = await sb.from("pipeline_leads").select("*", { count: "exact", head: true }).is("assigned_rep_id", null);
  step("S3. currentRepId:null matches unassigned only",
    r.body.detail?.total_to_move === (unassigned ?? 0),
    `server=${r.body.detail?.total_to_move} db=${unassigned}`);
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of fails) console.log(`  - ${f.label}: ${f.detail}`);
}
process.exit(fail === 0 ? 0 : 1);

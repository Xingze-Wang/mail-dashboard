// Smoke test the new bench-economy + artifacts tools by calling
// runReadTool() through a tiny server stub. We can't import the .ts
// directly without a bundler, so we hit the tool dispatch via
// /api/help/ask in shadow mode? — easier: just exercise the underlying
// SQL queries that runReadTool would issue, prove the data shapes
// match what the bot expects.
//
// Run: node scripts/smoke-bench-tools.mjs

import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } },
);

let passed = 0, failed = 0;
const pass = (l, info) => { passed++; console.log(`✓ ${l}${info ? "  " + info : ""}`); };
const fail = (l, e) => { failed++; console.error(`✗ ${l}: ${e}`); };

// ── get_congress_state ──────────────────────────────────────────────
try {
  const [{ data: companies }, { data: contracts }, { data: bets }, { data: ledger }, { data: pendingProps }] = await Promise.all([
    sb.from("bench_companies").select("id, name, active, target_segment, thesis"),
    sb.from("company_contracts").select("id, company_id, state, target_score, running_score").limit(40),
    sb.from("investor_bets").select("investor_id, company_id, conviction, action, decided_at").order("decided_at", { ascending: false }).limit(60),
    sb.from("investor_capital_ledger").select("investor_id, balance_after, occurred_at").order("occurred_at", { ascending: false }),
    sb.from("company_proposals").select("id, company_id, state").in("state", ["editor_review", "admin_review"]),
  ]);
  if (!companies?.length) throw new Error("no companies");
  if (!contracts?.length) throw new Error("no contracts");
  pass("get_congress_state",
    `→ ${companies.length} companies, ${contracts.length} contracts, ${bets.length} bets, ${pendingProps.length} pending`);
} catch (e) { fail("get_congress_state", e.message); }

// ── get_company_minutes ─────────────────────────────────────────────
try {
  const { data: companies } = await sb.from("bench_companies").select("id").limit(1);
  const cid = companies?.[0]?.id;
  if (!cid) throw new Error("no company to query");
  const { data } = await sb.from("bench_step_results")
    .select("step, loop, personas, recommendation, confidence, rationale, extra_fields, created_at")
    .eq("company_id", cid)
    .order("created_at", { ascending: false })
    .limit(5);
  if (!data?.length) throw new Error("no minutes");
  const m = data[0];
  if (!m.personas || typeof m.personas !== "object") throw new Error("personas not object");
  const personaKeys = Object.keys(m.personas);
  if (personaKeys.length < 2) throw new Error("expected ≥2 personas, got " + personaKeys.length);
  pass("get_company_minutes",
    `→ ${data.length} meetings, ${personaKeys.length} personas in latest (${personaKeys.join(",")})`);
} catch (e) { fail("get_company_minutes", e.message); }

// ── get_recent_proposals ────────────────────────────────────────────
try {
  const { data } = await sb.from("company_proposals")
    .select("id, company_id, kind, state, prediction, created_at, expires_at, company:bench_companies(name)")
    .order("created_at", { ascending: false }).limit(20);
  pass("get_recent_proposals", `→ ${data?.length ?? 0} rows, states: ${[...new Set((data ?? []).map(p => p.state))].join(",")}`);
} catch (e) { fail("get_recent_proposals", e.message); }

// ── get_investor_thinking ───────────────────────────────────────────
try {
  const { data: invs } = await sb.from("investor_agents").select("id").eq("active", true).limit(1);
  const invId = invs?.[0]?.id;
  if (!invId) throw new Error("no investors");
  const [{ data: inv }, { data: bets }] = await Promise.all([
    sb.from("investor_agents").select("id, name, style, memory").eq("id", invId).maybeSingle(),
    sb.from("investor_bets").select("company_id, conviction, action, rationale, decided_at").eq("investor_id", invId).order("decided_at", { ascending: false }).limit(20),
  ]);
  if (!inv) throw new Error("investor query failed");
  pass("get_investor_thinking",
    `→ ${inv.name} (${inv.style}), ${(inv.memory ?? []).length} memories, ${bets?.length ?? 0} bets`);
} catch (e) { fail("get_investor_thinking", e.message); }

// ── get_contract_status ─────────────────────────────────────────────
try {
  const { data: openContracts } = await sb.from("company_contracts")
    .select("id, action_label, segment, target_score, running_score, opened_at, closes_at, company:bench_companies(name)")
    .eq("state", "open").order("closes_at");
  pass("get_contract_status (list mode)", `→ ${openContracts?.length ?? 0} open contracts`);

  if (openContracts?.length > 0) {
    const cid = openContracts[0].id;
    const [{ data: ct }, { data: events }] = await Promise.all([
      sb.from("company_contracts").select("*, company:bench_companies(name)").eq("id", cid).maybeSingle(),
      sb.from("contract_event_attributions").select("event_kind, points_awarded, occurred_at").eq("contract_id", cid).order("occurred_at", { ascending: false }).limit(30),
    ]);
    pass("get_contract_status (single)", `→ ${ct?.action_label?.slice(0, 50)}, ${events?.length ?? 0} events`);
  }
} catch (e) { fail("get_contract_status", e.message); }

// ── get_my_artifacts (write + read round trip) ──────────────────────
try {
  const repId = 5; // Xingze, the smoke-test admin
  // Insert a synthetic artifact
  const { data: ins, error: insErr } = await sb.from("helper_artifacts").insert({
    rep_id: repId, kind: "lark_doc", lark_id: "smoke_test_" + Date.now(),
    title: "[smoke] artifact roundtrip",
    url: "https://example.com/smoke",
    meta: { source: "smoke-bench-tools" },
  }).select("id").single();
  if (insErr) throw insErr;
  // Read it back
  const { data: arts } = await sb.from("helper_artifacts")
    .select("kind, title, url, created_at")
    .eq("rep_id", repId).gte("created_at", new Date(Date.now() - 60_000).toISOString())
    .order("created_at", { ascending: false }).limit(5);
  if (!arts?.find(a => a.title === "[smoke] artifact roundtrip")) throw new Error("inserted artifact not retrievable");
  pass("get_my_artifacts", `→ ${arts.length} artifacts in last minute, includes the test row`);
  // Cleanup
  await sb.from("helper_artifacts").delete().eq("id", ins.id);
} catch (e) { fail("get_my_artifacts", e.message); }

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);

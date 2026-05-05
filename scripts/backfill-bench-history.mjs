// scripts/backfill-bench-history.mjs
//
// Seed 30+ days of company history starting 2026-03-31. Three companies
// funded by three different investors. Five weekly congress meetings
// per company, one monthly meeting at the end of week 4. Each meeting
// opens a contract, accrues backdated event attributions, settles, and
// writes investor bets + lifecycle events + episodic memory.
//
// Idempotent: skips companies/contracts that already exist by name+date.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// ── Config ──────────────────────────────────────────────────────────
const START_DATE = new Date("2026-03-31T09:00:00Z");
const FOUNDER  = "00000000-0000-0000-0000-000000000001";
const ATLAS    = "00000000-0000-0000-0000-000000000002";
const BRAMBLE  = "00000000-0000-0000-0000-000000000003";

// Three companies, each tied to one investor + one customer segment.
const COMPANIES = [
  {
    name: "Frontier Synth",
    tagline: "Frontier-model synthesis. Believes price-points beat data.",
    deliberation_style: "expansionist",
    color: "#8b5cf6",
    target_segment: "top_tier_academia",
    target_segment_label: "Domestic (.cn)", // segment label used by contracts/attribution
    thesis: "Frontier reasoning + expansionist deliberation finds 10x bets in Tier-1 .cn academia.",
    funded_by: ATLAS,
    model_roster: { weekly_default: "claude-sonnet-4.6", weekly_synth_model: "claude-opus-4.7" },
  },
  {
    name: "Lean Fleet",
    tagline: "Cheap fast persona models, frontier only at synth.",
    deliberation_style: "empiricist",
    color: "#0ea5e9",
    target_segment: "mid_tier_startup",
    target_segment_label: "Overseas",
    thesis: "Empiricist deliberation on overseas .edu finds repeatable A/B wins.",
    funded_by: FOUNDER,
    model_roster: { weekly_default: "gemini-2.5-flash", weekly_synth_model: "claude-sonnet-4.6" },
  },
  {
    name: "Cautious Council",
    tagline: "Conservative; defaults to defer when in doubt.",
    deliberation_style: "conservative",
    color: "#64748b",
    target_segment: "gov_lab",
    target_segment_label: "Domestic (.cn)",
    thesis: "Conservative deliberation prevents bad sends; high precision over recall.",
    funded_by: BRAMBLE,
    model_roster: { weekly_default: "gemini-2.5-flash", weekly_synth_model: "gemini-2.5-flash" },
  },
];

// Per-week realistic event accrual. Index 0 = week 1, etc.
// Each company has its own arc — Frontier wins early, fades; Lean
// improves steadily; Cautious is flat-but-safe.
const COMPANY_TRAJECTORIES = {
  "Frontier Synth": [
    { clicks: 12, wechats: 4, replies: 1, hit: true,  rationale: "Strong opener performed well in tier-1 .cn — expansionist Synth picked an aggressive angle." },
    { clicks: 14, wechats: 5, replies: 2, hit: true,  rationale: "Repeated success — Frontier's prompts are clicking with elite labs." },
    { clicks: 8,  wechats: 2, replies: 1, hit: false, rationale: "Audience saturating; same authors stopped clicking on second touch." },
    { clicks: 6,  wechats: 1, replies: 0, hit: false, rationale: "Cohort is fully exhausted; thesis needs revisit." },
    { clicks: 9,  wechats: 3, replies: 1, hit: true,  rationale: "Expanded sub-segment to 985 schools; partial recovery." },
  ],
  "Lean Fleet": [
    { clicks: 6,  wechats: 1, replies: 1, hit: false, rationale: "Cheap-model drafts undershot tone for overseas profs." },
    { clicks: 9,  wechats: 2, replies: 1, hit: true,  rationale: "A/B narrowed in on citation-hook variant; modest lift." },
    { clicks: 12, wechats: 4, replies: 2, hit: true,  rationale: "Pattern landed — overseas industry researchers responding to compute-offer angle." },
    { clicks: 14, wechats: 5, replies: 3, hit: true,  rationale: "Strong week; cheap persona models holding up against frontier." },
    { clicks: 11, wechats: 4, replies: 2, hit: true,  rationale: "Steady; the cheap-model thesis is paying off." },
  ],
  "Cautious Council": [
    { clicks: 4,  wechats: 1, replies: 0, hit: false, rationale: "Deferred too many; only sent the highest-conviction subset." },
    { clicks: 5,  wechats: 1, replies: 1, hit: false, rationale: "High precision but volume too low to clear target." },
    { clicks: 6,  wechats: 2, replies: 1, hit: true,  rationale: "Approval bar relaxed slightly; small win in gov lab segment." },
    { clicks: 5,  wechats: 1, replies: 0, hit: false, rationale: "Adversary blocked two proposals; nothing shipped." },
    { clicks: 7,  wechats: 2, replies: 1, hit: true,  rationale: "Quiet week; hit lower target. Conservative is still alive." },
  ],
};

// ── Helpers ─────────────────────────────────────────────────────────
function addDays(d, days) { return new Date(d.getTime() + days * 86_400_000); }
function iso(d) { return d.toISOString(); }

async function getCurrentPointsVersionId() {
  const { data } = await sb
    .from("points_table_versions")
    .select("id, version, effective_from")
    .order("version", { ascending: true })
    .limit(1)
    .single();
  return data?.id;
}

async function ensureCompany(spec) {
  // Skip if a company with this name already exists.
  const { data: existing } = await sb
    .from("bench_companies")
    .select("id, name")
    .eq("name", spec.name)
    .maybeSingle();
  if (existing) {
    console.log(`  [exists] ${spec.name} → ${existing.id}`);
    return existing.id;
  }
  const { data, error } = await sb
    .from("bench_companies")
    .insert({
      name: spec.name,
      tagline: spec.tagline,
      deliberation_style: spec.deliberation_style,
      model_roster: spec.model_roster,
      persona_overrides: {},
      customer_profile: { segment: spec.target_segment },
      color: spec.color,
      thesis: spec.thesis,
      target_segment: spec.target_segment,
      funded_by: spec.funded_by,
      funded_at: iso(START_DATE),
      active: true,
      created_at: iso(START_DATE),
    })
    .select("id")
    .single();
  if (error) throw error;
  console.log(`  [created] ${spec.name} → ${data.id}`);
  return data.id;
}

async function recordFundingLifecycle(companyId, spec) {
  const { data: existing } = await sb
    .from("company_lifecycle")
    .select("id")
    .eq("company_id", companyId)
    .eq("event", "funded")
    .maybeSingle();
  if (existing) return;

  // Get investor name for label.
  const { data: inv } = await sb.from("investor_agents").select("name").eq("id", spec.funded_by).single();
  await sb.from("company_lifecycle").insert({
    company_id: companyId,
    event: "funded",
    label: `Funded by ${inv?.name ?? "?"}`,
    meta: { investor_id: spec.funded_by, thesis: spec.thesis, conviction: 0.6 },
    occurred_at: iso(START_DATE),
  });

  // Initial bet + capital stake.
  await sb.from("investor_bets").insert({
    investor_id: spec.funded_by,
    company_id: companyId,
    conviction: 0.6,
    action: "fund",
    rationale: `Initial funding: ${spec.thesis}`,
    metric_snapshot: {},
    decided_at: iso(START_DATE),
  });
}

async function runWeek(companyId, spec, weekIdx, pointsVersionId) {
  const opensAt = addDays(START_DATE, weekIdx * 7);
  const closesAt = addDays(opensAt, 7);
  const traj = COMPANY_TRAJECTORIES[spec.name][weekIdx];
  if (!traj) return;

  // Skip if a contract already opened that day for this company.
  const { data: existing } = await sb
    .from("company_contracts")
    .select("id")
    .eq("company_id", companyId)
    .gte("opened_at", iso(opensAt))
    .lt("opened_at", iso(addDays(opensAt, 1)))
    .maybeSingle();
  if (existing) {
    console.log(`    [exists] week ${weekIdx + 1} contract for ${spec.name}`);
    return;
  }

  // Open contract — backdated.
  const target = 30; // points
  const stake = 50;
  const actionLabel = traj.hit
    ? `Week ${weekIdx + 1}: ship ${spec.deliberation_style} variant to ${spec.target_segment_label}`
    : `Week ${weekIdx + 1}: cautious push on ${spec.target_segment_label}`;

  const { data: contract, error } = await sb
    .from("company_contracts")
    .insert({
      company_id: companyId,
      points_version_id: pointsVersionId,
      rep_id: null,
      segment: spec.target_segment_label,
      action_label: actionLabel,
      action_spec: { kind: "weekly_directive", style: spec.deliberation_style },
      target_score: target,
      running_score: 0,
      capital_staked: stake,
      state: "open",
      prediction: traj.rationale,
      opened_at: iso(opensAt),
      closes_at: iso(closesAt),
      created_at: iso(opensAt),
    })
    .select("id")
    .single();
  if (error) throw error;

  // Backdated investor stake row.
  const { data: latestBalance } = await sb
    .from("investor_capital_ledger")
    .select("balance_after")
    .eq("investor_id", spec.funded_by)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .single();
  const balance = Number(latestBalance?.balance_after ?? 0);
  await sb.from("investor_capital_ledger").insert({
    investor_id: spec.funded_by,
    kind: "stake",
    delta: -stake,
    balance_after: balance - stake,
    contract_id: contract.id,
    company_id: companyId,
    note: `Stake on ${actionLabel.slice(0, 60)}`,
    occurred_at: iso(opensAt),
  });

  // Distribute backdated events through the week.
  // click=3, wechat=2, reply=4 under v1 weights.
  const events = [];
  for (let i = 0; i < traj.clicks; i++) {
    events.push({ kind: "click", pts: 3, when: addDays(opensAt, 0.5 + i * 0.4) });
  }
  for (let i = 0; i < traj.wechats; i++) {
    events.push({ kind: "wechat", pts: 2, when: addDays(opensAt, 1 + i * 0.7) });
  }
  for (let i = 0; i < traj.replies; i++) {
    events.push({ kind: "reply", pts: 4, when: addDays(opensAt, 2 + i * 1.1) });
  }

  let running = 0;
  for (const ev of events) {
    await sb.from("contract_event_attributions").insert({
      contract_id: contract.id,
      source_kind: "backfill",
      source_id: null,
      event_kind: ev.kind,
      points_awarded: ev.pts,
      occurred_at: iso(ev.when),
      created_at: iso(ev.when),
    });
    running += ev.pts;
  }

  // Settle contract — backdated to closesAt.
  const finalState = traj.hit ? "hit" : "missed";
  await sb.from("company_contracts").update({
    running_score: running,
    state: finalState,
    settled_at: iso(closesAt),
    postmortem: traj.rationale,
  }).eq("id", contract.id);

  // Capital settle: 1.5x refund on hit, forfeit on miss.
  const { data: latest2 } = await sb
    .from("investor_capital_ledger")
    .select("balance_after")
    .eq("investor_id", spec.funded_by)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .single();
  const bal2 = Number(latest2?.balance_after ?? 0);
  const refund = finalState === "hit" ? stake * 1.5 : 0;
  await sb.from("investor_capital_ledger").insert({
    investor_id: spec.funded_by,
    kind: finalState === "hit" ? "refund" : "forfeit",
    delta: refund,
    balance_after: bal2 + refund,
    contract_id: contract.id,
    company_id: companyId,
    note: finalState === "hit" ? "Refund + 50% bonus on hit" : "Forfeit on miss",
    occurred_at: iso(closesAt),
  });

  // Lifecycle event for the contract close.
  await sb.from("company_lifecycle").insert({
    company_id: companyId,
    event: finalState === "hit" ? "first_ship" : "milestone",
    label: finalState === "hit" ? `Contract HIT: ${actionLabel}` : `Contract MISSED: ${actionLabel}`,
    meta: { contract_id: contract.id, state: finalState, target, running, postmortem: traj.rationale },
    occurred_at: iso(closesAt),
  });

  // Episodic memory — what the company "remembers" of this contract.
  await sb.from("company_episodic_memory").insert({
    company_id: companyId,
    contract_id: contract.id,
    summary: `${finalState.toUpperCase()}: "${actionLabel}" — landed ${running}/${target} pts. ${traj.rationale}`,
    details: {
      action_label: actionLabel,
      target_score: target,
      points_landed: running,
      capital_staked: stake,
      state: finalState,
      surprise: finalState === "hit" ? running > target * 1.5 : running < target * 0.3,
    },
    occurred_at: iso(closesAt),
    created_at: iso(closesAt),
  });

  // Investor re-bet at week-end — conviction drift based on hit/miss.
  const { data: prevBet } = await sb
    .from("investor_bets")
    .select("conviction")
    .eq("investor_id", spec.funded_by)
    .eq("company_id", companyId)
    .order("decided_at", { ascending: false })
    .limit(1)
    .single();
  const prior = Number(prevBet?.conviction ?? 0.6);
  const next = finalState === "hit" ? Math.min(1, prior + 0.1) : Math.max(0, prior - 0.12);
  const action = next > 0.85 ? "double_down" : next < 0.2 ? "cut" : finalState === "hit" ? "hold" : "trim";
  await sb.from("investor_bets").insert({
    investor_id: spec.funded_by,
    company_id: companyId,
    conviction: Number(next.toFixed(3)),
    action,
    rationale: `${finalState === "hit" ? "Hit" : "Missed"} target — ${running}/${target} pts. ${traj.rationale}`,
    metric_snapshot: { points_landed: running, target },
    decided_at: iso(closesAt),
  });

  // Conviction-change lifecycle if material.
  if (Math.abs(next - prior) >= 0.1) {
    await sb.from("company_lifecycle").insert({
      company_id: companyId,
      event: "conviction_change",
      label: `Conviction ${prior.toFixed(2)} → ${next.toFixed(2)} (${action})`,
      meta: { prior, next, action },
      occurred_at: iso(closesAt),
    });
  }

  // bench_step_results so the timeline shows a meeting dot.
  await sb.from("bench_step_results").insert({
    session_id: null, // standalone backfill, no session
    company_id: companyId,
    step: weekIdx,
    loop: "weekly",
    personas: { synthesizer: traj.rationale.slice(0, 200) },
    recommendation: finalState === "hit" ? "approve" : "defer",
    confidence: finalState === "hit" ? 0.75 : 0.45,
    rationale: traj.rationale,
    extra_fields: { contract_id: contract.id },
    latency_s: 12.3,
    error: null,
    created_at: iso(opensAt),
  }).then((r) => { if (r.error) console.warn("    bench_step_results insert warning:", r.error.message); });

  // Backfill a couple of proposals during this week to populate /editor.
  if (weekIdx === 1 || weekIdx === 3) {
    await sb.from("company_proposals").insert({
      company_id: companyId,
      contract_id: contract.id,
      kind: weekIdx === 1 ? "subject_test" : "draft_revise",
      payload: weekIdx === 1
        ? { current_subject: "看到你最近的工作", proposed_subject: "你那篇论文用了多少 H100?", segment: spec.target_segment_label }
        : { current_draft: "尊敬的教授...", proposed_draft: "教授好。看到了你最近的工作。", segment: spec.target_segment_label },
      affected_targets: {},
      prediction: traj.rationale,
      state: weekIdx === 1 ? "executed" : "admin_review",
      executed_at: weekIdx === 1 ? iso(addDays(opensAt, 1)) : null,
      execution_result: weekIdx === 1 ? { stub: true, note: "Backfill execution stub." } : null,
      created_at: iso(opensAt),
      expires_at: iso(addDays(opensAt, 14)),
    }).then((r) => { if (r.error) console.warn("    proposal insert warning:", r.error.message); });
  }

  console.log(`    week ${weekIdx + 1} (${spec.name}): ${finalState} — ${running}/${target} pts, conviction ${prior.toFixed(2)}→${next.toFixed(2)}`);
}

async function runMonthly(companyId, spec, pointsVersionId) {
  // Fires at end of week 4 (after 4 weekly contracts settled). One
  // strategic-loop meeting that may issue a directive.
  const at = addDays(START_DATE, 4 * 7 + 1);
  const { data: existing } = await sb
    .from("bench_step_results")
    .select("id")
    .eq("company_id", companyId)
    .eq("loop", "monthly")
    .maybeSingle();
  if (existing) return;

  await sb.from("bench_step_results").insert({
    session_id: null,
    company_id: companyId,
    step: 4,
    loop: "monthly",
    personas: { synthesizer: `Monthly review for ${spec.name}: directive issued for next 4 weeks.` },
    recommendation: "approve",
    confidence: 0.7,
    rationale: `Monthly directive: ${spec.thesis} — keep concentration on ${spec.target_segment_label}.`,
    extra_fields: { directive: spec.thesis },
    latency_s: 28.5,
    error: null,
    created_at: iso(at),
  });

  await sb.from("company_lifecycle").insert({
    company_id: companyId,
    event: "milestone",
    label: `Monthly directive: stay on ${spec.target_segment_label}`,
    meta: { loop: "monthly" },
    occurred_at: iso(at),
  });
}

// ── Main ────────────────────────────────────────────────────────────
console.log("Backfill starting from", iso(START_DATE));

const pointsVersionId = await getCurrentPointsVersionId();
if (!pointsVersionId) {
  console.error("No active points_table_versions found — apply migration 041 first.");
  process.exit(1);
}
console.log("Using points_version:", pointsVersionId);

for (const spec of COMPANIES) {
  console.log(`\n${spec.name}`);
  const companyId = await ensureCompany(spec);
  await recordFundingLifecycle(companyId, spec);
  for (let w = 0; w < 5; w++) {
    await runWeek(companyId, spec, w, pointsVersionId);
  }
  await runMonthly(companyId, spec, pointsVersionId);
}

// Final summary.
const finals = await sb.from("company_contracts").select("state").then(r => r.data ?? []);
const hits = finals.filter(f => f.state === "hit").length;
const misses = finals.filter(f => f.state === "missed").length;
console.log(`\nDone. Contracts: ${finals.length} (${hits} hit, ${misses} miss).`);

const balances = await sb.from("investor_capital_ledger")
  .select("investor_id, balance_after, occurred_at")
  .order("occurred_at", { ascending: false });
const seen = new Set();
console.log("\nInvestor balances:");
for (const r of balances.data ?? []) {
  if (seen.has(r.investor_id)) continue;
  seen.add(r.investor_id);
  const inv = await sb.from("investor_agents").select("name").eq("id", r.investor_id).single();
  console.log(`  ${inv.data.name}: ${r.balance_after}`);
}

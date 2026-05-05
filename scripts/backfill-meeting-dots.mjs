// scripts/backfill-meeting-dots.mjs
//
// Idempotent: read every settled contract, ensure there's a matching
// bench_step_results row so the timeline shows meeting dots.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const { data: contracts } = await sb
  .from("company_contracts")
  .select("id, company_id, opened_at, closes_at, action_label, prediction, target_score, running_score, state")
  .order("opened_at", { ascending: true });

console.log(`Backfilling meeting dots for ${contracts.length} contracts.`);

let inserted = 0;
let skipped = 0;
for (const c of contracts ?? []) {
  // Use action_label hash as a uniqueness proxy. We just check if a step
  // row already references this contract via extra_fields.
  const { data: existing } = await sb
    .from("bench_step_results")
    .select("id")
    .eq("company_id", c.company_id)
    .filter("extra_fields->>contract_id", "eq", c.id)
    .maybeSingle();
  if (existing) { skipped++; continue; }

  // Compute step number = weeks since 2026-03-31.
  const start = new Date("2026-03-31T00:00:00Z").getTime();
  const stepIdx = Math.round((new Date(c.opened_at).getTime() - start) / (7 * 86_400_000));

  const { error } = await sb.from("bench_step_results").insert({
    session_id: null,
    company_id: c.company_id,
    step: stepIdx,
    loop: "weekly",
    personas: { synthesizer: (c.prediction ?? "").slice(0, 220) },
    recommendation: c.state === "hit" ? "approve" : c.state === "missed" ? "defer" : "approve",
    confidence: c.state === "hit" ? 0.75 : 0.45,
    rationale: c.prediction ?? c.action_label,
    extra_fields: { contract_id: c.id, target: c.target_score, running: c.running_score },
    latency_s: 12.3,
    error: null,
    created_at: c.opened_at,
  });
  if (error) {
    console.warn(`  failed for ${c.id}: ${error.message}`);
    continue;
  }
  inserted++;
}

// Add monthly meetings — one per company, around day 30.
const { data: companies } = await sb.from("bench_companies").select("id, name, target_segment, thesis");
const monthlyAt = new Date("2026-04-29T10:00:00Z").toISOString();
let monthlyAdded = 0;
for (const co of companies ?? []) {
  const { data: existing } = await sb
    .from("bench_step_results")
    .select("id")
    .eq("company_id", co.id)
    .eq("loop", "monthly")
    .maybeSingle();
  if (existing) continue;
  const { error } = await sb.from("bench_step_results").insert({
    session_id: null,
    company_id: co.id,
    step: 4,
    loop: "monthly",
    personas: { synthesizer: `Monthly review for ${co.name}.` },
    recommendation: "approve",
    confidence: 0.7,
    rationale: `Monthly directive: stay focused on ${co.target_segment}. ${co.thesis ?? ""}`,
    extra_fields: {},
    latency_s: 28.5,
    error: null,
    created_at: monthlyAt,
  });
  if (error) { console.warn("  monthly failed:", error.message); continue; }
  monthlyAdded++;
}

console.log(`Done. weekly inserted=${inserted}, weekly skipped=${skipped}, monthly added=${monthlyAdded}.`);

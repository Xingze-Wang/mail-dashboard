import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { data: hyps } = await sb
  .from("congress_hypotheses")
  .select("*")
  .order("generated_at", { ascending: false });
console.log(`\n=== ${hyps?.length ?? 0} hypotheses ===\n`);
for (const h of hyps ?? []) {
  console.log(`──── ${h.id.slice(0, 8)} [${h.status}] ────`);
  console.log(`Hypothesis: ${h.hypothesis}`);
  console.log(`Reasoning: ${h.reasoning}`);
  console.log(`Segment: ${JSON.stringify(h.segment)}`);
  console.log(`Proposed template: ${h.proposed_template_id?.slice(0, 8) ?? "(none)"}`);
  if (h.outcome_evidence) console.log(`Outcome: ${JSON.stringify(h.outcome_evidence)}`);
  console.log("");
}
const { data: tpls } = await sb
  .from("email_templates")
  .select("id, name, status, segment_default, proposed_reason, proposed_evidence")
  .eq("status", "proposal");
console.log(`\n=== ${tpls?.length ?? 0} proposal templates ===\n`);
for (const t of tpls ?? []) {
  console.log(`──── ${t.name} (${t.id.slice(0,8)}) seg=${t.segment_default}────`);
  console.log(`Reason: ${(t.proposed_reason ?? '').slice(0, 300)}...`);
  console.log("");
}

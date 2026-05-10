import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } }
);
const tables = [
  "pipeline_leads","emails","brief_lookups","webhook_events","sales_reps","persons","person_enrichment_candidates",
  "email_template_overrides","email_templates","email_contact_history","inbound_emails","templates",
  "discovery_leads","scorer_runs","tactical_proposals","tactical_proposal_observations",
  "congress_runs","congress_interjections","congress_hypotheses","quarterly_goals","team_focus","missions","mission_progress",
  "template_ratings","template_edits","jitr_offers","email_template_test_results","email_template_proposals",
  "rep_trust_levels","onboarding_followups","helper_predictions","helper_messages","helper_learnings",
  "drift_groups","drift_findings","drift_proposals","blocklist","points","reweight_runs","drift_signals",
  "v_mission_today",
];
for (const t of tables) {
  try {
    const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
    if (error) console.log("MISSING:", t, "→", error.message);
  } catch(e) { console.log("THROW:", t, e.message); }
}
console.log("done");

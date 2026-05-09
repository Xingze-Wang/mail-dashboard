/**
 * Reproduce the /api/templates/[id]/inspect failure server-side by
 * calling the underlying logic with the same template id. Bypasses
 * Vercel WAF on CLI.
 */
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const TPL_ID = "06cef2d3-ed0a-43cf-8c04-77fb6b0fd169";

const { data: tpl } = await sb.from("email_templates").select("*").eq("id", TPL_ID).maybeSingle();
console.log("Template:", tpl ? `${tpl.name} (status=${tpl.status})` : "NOT FOUND");

// Same query the route uses
const { data: lead, error: leadErr } = await sb
  .from("pipeline_leads")
  .select("id, title, abstract, author_email, first_name, school_name, school_tier, matched_directions, assigned_rep_id")
  .not("assigned_rep_id", "is", null)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
console.log("\nLatest assigned-pipeline lead:");
if (leadErr) console.log("  ERROR:", leadErr.message);
console.log(`  id=${lead?.id} title="${lead?.title?.slice(0,60)}" first_name="${lead?.first_name}" assigned_rep_id=${lead?.assigned_rep_id}`);

// Could matched_directions be the issue? assembleDraft expects array.
console.log(`  matched_directions type=${typeof lead?.matched_directions} value=`, lead?.matched_directions);

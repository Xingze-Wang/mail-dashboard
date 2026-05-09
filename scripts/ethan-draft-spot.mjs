import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { data } = await sb
  .from("pipeline_leads")
  .select("id, draft_subject, draft_html")
  .eq("assigned_rep_id", 3)
  .eq("status", "ready")
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
console.log("subject:", data?.draft_subject);
console.log("\n--- html ---");
console.log(data?.draft_html);

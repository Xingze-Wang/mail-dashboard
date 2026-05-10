import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } }
);

const { data: tpls } = await sb.from("email_templates").select("id, name, status, rep_id").order("updated_at", { ascending: false }).limit(30);
console.log("email_templates:", tpls?.length);
const statusCounts = {};
for (const t of tpls ?? []) statusCounts[t.status] = (statusCounts[t.status]||0)+1;
console.log("status:", statusCounts);

// Templates table (legacy)
const { data: legacy } = await sb.from("templates").select("id, name, active").limit(10);
console.log("legacy templates:", legacy?.length);

// template_edits
const { data: edits } = await sb.from("template_edits").select("status").limit(100);
const editStatus = {};
for (const e of edits ?? []) editStatus[e.status] = (editStatus[e.status]||0)+1;
console.log("template_edits status:", editStatus);

// template_ratings
const { data: ratings } = await sb.from("template_ratings").select("template_id, rating").limit(10);
console.log("template_ratings:", ratings?.length);

// template_segments
const { data: segs } = await sb.from("email_template_overrides").select("template_id").limit(10);
console.log("email_template_overrides:", segs?.length);

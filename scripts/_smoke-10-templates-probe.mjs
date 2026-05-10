import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } }
);

const { data: legacy, error: e1 } = await sb.from("templates").select("id, name").limit(3);
console.log("templates table:", e1?.message ?? `${legacy?.length} rows`, legacy);

const { data: ratings, error: e2 } = await sb.from("template_ratings").select("*").limit(3);
console.log("template_ratings table:", e2?.message ?? `${ratings?.length} rows`, ratings);

// Count
const { count, error: e3 } = await sb.from("email_templates").select("id", { count: "exact", head: true });
console.log("email_templates count:", e3?.message ?? count);

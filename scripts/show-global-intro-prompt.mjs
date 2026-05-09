import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { data } = await sb
  .from("email_templates")
  .select("name, intro_prompt, greeting_format, rep_intro_format, school_pitch_format, cta_signoff_format")
  .eq("status", "active")
  .eq("name", "global")
  .maybeSingle();
console.log("=== GLOBAL TEMPLATE — current production intro_prompt ===\n");
console.log(data?.intro_prompt);
console.log("\n=== greeting_format ===\n");
console.log(data?.greeting_format);
console.log("\n=== rep_intro_format ===\n");
console.log(data?.rep_intro_format);
console.log("\n=== school_pitch_format ===\n");
console.log(data?.school_pitch_format);
console.log("\n=== cta_signoff_format ===\n");
console.log(data?.cta_signoff_format);

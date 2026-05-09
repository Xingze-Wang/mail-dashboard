import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { data } = await sb
  .from("email_templates")
  .select("name, school_pitch_format, intro_prompt, proposed_evidence, created_at")
  .eq("status", "proposal")
  .order("created_at", { ascending: false })
  .limit(3);
for (const t of data ?? []) {
  console.log(`\n══ ${t.name} ══`);
  const slot = t.proposed_evidence?.slot_swapped ?? "school_pitch_format";
  const text = t[slot] ?? "(?)";
  console.log(`Slot: ${slot}`);
  console.log(`What changed: ${t.proposed_evidence?.what_changed ?? "?"}`);
  console.log(`\n--- new content ---`);
  console.log(text);
}

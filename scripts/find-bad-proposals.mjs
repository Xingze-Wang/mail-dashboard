import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { data } = await sb
  .from("email_templates")
  .select("id, name, status, intro_prompt, school_pitch_format, rep_intro_format, cta_signoff_format, greeting_format, subject_format, proposed_evidence, created_at")
  .eq("status", "proposal")
  .order("created_at", { ascending: false });

console.log(`${data?.length ?? 0} proposals.\n`);
const SUS_PATTERNS = [
  /感谢.*作者.*论文/, /感谢.*您.*工作/, /thank.*author/i, /thank you for.*paper/i,
  /您.*这篇/, /your contribution/i, /您的论文/, /对您论文/,
];
for (const t of data ?? []) {
  const slot = t.proposed_evidence?.slot_swapped ?? "school_pitch_format";
  const text = t[slot] ?? "";
  const hits = SUS_PATTERNS.filter((p) => p.test(text));
  if (hits.length > 0) {
    console.log(`⚠️  ${t.name}`);
    console.log(`    slot=${slot}  patterns=${hits.length}`);
    console.log(`    text: ${text.slice(0, 300)}\n`);
  }
}

console.log("\n--- For human review, full text of all 3 most recent: ---");
for (const t of (data ?? []).slice(0, 3)) {
  const slot = t.proposed_evidence?.slot_swapped ?? "school_pitch_format";
  console.log(`\n══ ${t.name} (slot=${slot}) ══`);
  console.log(t[slot] ?? "(no content)");
}

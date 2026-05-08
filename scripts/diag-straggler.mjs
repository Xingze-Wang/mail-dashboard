import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);
const { data: leads } = await sb
  .from("pipeline_leads")
  .select("id, draft_html")
  .or("draft_html.ilike.%杜雨洁%,draft_html.ilike.%Chenyu%")
  .not("status", "in", "(sent,skipped,replied)")
  .limit(2);
for (const l of leads ?? []) {
  console.log(`\n--- lead ${l.id} ---`);
  const html = l.draft_html ?? "";
  // Find any window containing 杜 or Chenyu
  for (const term of ["杜雨洁", "杜", "Chenyu", "chenyu"]) {
    const idx = html.indexOf(term);
    if (idx >= 0) {
      const window = html.slice(Math.max(0, idx - 20), idx + 30);
      console.log(`  has "${term}" at ${idx}: ...${window}...`);
      // Print bytes around the match for debug
      for (let i = idx; i < idx + term.length + 4 && i < html.length; i++) {
        console.log(`    ${i}: U+${html.charCodeAt(i).toString(16).padStart(4, '0')} "${html[i]}"`);
      }
      break;
    }
  }
}

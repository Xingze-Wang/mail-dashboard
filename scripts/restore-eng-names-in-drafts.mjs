import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const SWAPS = [
  { wrong: "杜雨洁", right: "Yujie", repId: 2 },
  { wrong: "曹鸿宇泽", right: "Ethan", repId: 3 },
  { wrong: "王幸泽", right: "Xingze", repId: 5 },
];

for (const s of SWAPS) {
  const { data: leads } = await sb
    .from("pipeline_leads")
    .select("id, draft_html, draft_subject")
    .eq("assigned_rep_id", s.repId)
    .not("status", "in", "(sent,skipped,replied)")
    .or(`draft_html.ilike.%${s.wrong}%,draft_subject.ilike.%${s.wrong}%`);
  console.log(`rep_id=${s.repId} (${s.right}): ${leads?.length ?? 0} drafts contain "${s.wrong}"`);
  let fixed = 0;
  for (const l of leads ?? []) {
    const newHtml = (l.draft_html ?? "").split(s.wrong).join(s.right);
    const newSubject = (l.draft_subject ?? "").split(s.wrong).join(s.right);
    if (newHtml === l.draft_html && newSubject === l.draft_subject) continue;
    await sb.from("pipeline_leads")
      .update({ draft_html: newHtml, draft_subject: newSubject })
      .eq("id", l.id);
    fixed++;
  }
  console.log(`  fixed ${fixed}`);
}

// Upsert every pipeline_leads.arxiv_id into the `papers` table so the
// repo-firewall + paper-firewall has full coverage. Idempotent.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const HF = /(?:huggingface\.co\/(?:models?\/|datasets?\/|spaces\/)?)([\w-]+\/[\w.-]+)/gi;
const GH = /github\.com\/([\w-]+\/[\w.-]+)/gi;
function norm(r) { return r.replace(/[.,)\]\s]+$/, "").trim(); }
function pick(arr) {
  const f = arr.filter(x => !x.toLowerCase().startsWith("anonymous/") && !x.toLowerCase().startsWith("anon/"));
  const c = new Map();
  for (const r of f) c.set(r, (c.get(r) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

let off = 0, total = 0, applied = 0;
while (true) {
  const { data, error } = await sb
    .from("pipeline_leads")
    .select("arxiv_id, title, abstract, published_at, sent_at")
    .not("arxiv_id", "is", null)
    .range(off, off + 999);
  if (error) {
    console.error(error.message);
    break;
  }
  if (!data || data.length === 0) break;

  const rows = data.map((r) => {
    const text = r.abstract ?? "";
    const hf = pick([...text.matchAll(HF)].map((m) => norm(m[1])));
    const gh = pick([...text.matchAll(GH)].map((m) => norm(m[1])));
    return {
      arxiv_id: r.arxiv_id,
      title: r.title,
      abstract: r.abstract,
      published_at: r.published_at,
      hf_repo: hf,
      github_repo: gh,
      last_outreach_at: r.sent_at ?? null,
      outreach_count: r.sent_at ? 1 : 0,
    };
  });

  // Upsert in batches of 100
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const { error: e } = await sb.from("papers").upsert(batch, { onConflict: "arxiv_id", ignoreDuplicates: false });
    if (e) console.error("upsert batch err:", e.message);
    else applied += batch.length;
  }
  total += data.length;
  off += data.length;
  process.stdout.write(`  ${total}\r`);
  if (data.length < 1000) break;
}
process.stdout.write("\n");
console.log(`Scanned: ${total}, upserted: ${applied}`);

const { count: papersTotal } = await sb.from("papers").select("*", { count: "exact", head: true });
const { count: papersWithGh } = await sb.from("papers").select("*", { count: "exact", head: true }).not("github_repo", "is", null);
const { count: papersWithHf } = await sb.from("papers").select("*", { count: "exact", head: true }).not("hf_repo", "is", null);
const { count: papersWithOutreach } = await sb.from("papers").select("*", { count: "exact", head: true }).gt("outreach_count", 0);
console.log(`\nFinal papers coverage:`);
console.log(`  total: ${papersTotal}`);
console.log(`  with github_repo: ${papersWithGh}`);
console.log(`  with hf_repo: ${papersWithHf}`);
console.log(`  with outreach > 0: ${papersWithOutreach}`);

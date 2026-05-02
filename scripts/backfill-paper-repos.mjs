// Walk every paper that has an abstract, run repo-extractor, write hf_repo
// and github_repo. For papers without abstracts we'd need to fetch the
// arxiv api — skip for now, do those in a later pass.
//
// This is the stage that turns the new repo-firewall on. Without populated
// repo columns, the firewall is a no-op.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Inline the extractor (mjs can't import .ts)
const HF_PATTERN = /(?:huggingface\.co\/(?:models?\/|datasets?\/|spaces\/)?)([\w-]+\/[\w.-]+)/gi;
const GH_PATTERN = /github\.com\/([\w-]+\/[\w.-]+)/gi;

function normalize(repo) {
  return repo.replace(/[.,)\]\s]+$/, "").trim();
}
function pickBest(matches) {
  if (!matches.length) return null;
  const filtered = matches.filter((r) => {
    const l = r.toLowerCase();
    return !l.startsWith("anonymous/") && !l.startsWith("anon/");
  });
  const counts = new Map();
  for (const r of filtered) counts.set(r, (counts.get(r) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}
function extract(text) {
  if (!text) return { hf: null, gh: null };
  const hf = pickBest([...text.matchAll(HF_PATTERN)].map((m) => normalize(m[1])));
  const gh = pickBest([...text.matchAll(GH_PATTERN)].map((m) => normalize(m[1])));
  return { hf, gh };
}

// 1. Pull every paper with abstract OR pipeline_lead with abstract — both
//    feed into the same papers row by arxiv_id.
console.log("Loading papers + pipeline_leads abstracts...");
const abstractByArxiv = new Map();
async function loadAbs(table, arxivField) {
  let off = 0;
  while (true) {
    const { data, error } = await sb.from(table).select(`${arxivField}, abstract`).not("abstract", "is", null).range(off, off + 999);
    if (error) {
      console.error(table, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (r[arxivField] && r.abstract && !abstractByArxiv.has(r[arxivField])) {
        abstractByArxiv.set(r[arxivField], r.abstract);
      }
    }
    off += data.length;
    if (data.length < 1000) break;
  }
}
await loadAbs("papers", "arxiv_id");
await loadAbs("pipeline_leads", "arxiv_id");
console.log(`  loaded ${abstractByArxiv.size} abstracts`);

// 2. For each, extract repos
let withHf = 0, withGh = 0, withBoth = 0, none = 0;
const updates = [];
for (const [arxivId, abs] of abstractByArxiv) {
  const { hf, gh } = extract(abs);
  if (hf && gh) withBoth++;
  else if (hf) withHf++;
  else if (gh) withGh++;
  else none++;
  if (hf || gh) updates.push({ arxivId, hf, gh });
}
console.log(`\nExtracted: hf-only=${withHf}, gh-only=${withGh}, both=${withBoth}, none=${none}`);
console.log(`Sample wins:`, updates.slice(0, 5));

// 3. Apply (papers table)
let applied = 0, failed = 0;
for (let i = 0; i < updates.length; i += 50) {
  const batch = updates.slice(i, i + 50);
  await Promise.all(batch.map(async (u) => {
    const update = {};
    if (u.hf) update.hf_repo = u.hf;
    if (u.gh) update.github_repo = u.gh;
    const { error } = await sb.from("papers").update(update).eq("arxiv_id", u.arxivId);
    if (error) {
      // If the paper row doesn't exist (in our DB only as a pipeline_leads row),
      // upsert it.
      const { error: upErr } = await sb.from("papers").upsert({ arxiv_id: u.arxivId, ...update }, { onConflict: "arxiv_id" });
      if (upErr) {
        failed++;
        return;
      }
    }
    applied++;
  }));
  process.stdout.write(`  applied ${applied}/${updates.length}\r`);
}
process.stdout.write("\n");

console.log(`\n=== Repo backfill summary ===`);
console.log(`Abstracts scanned: ${abstractByArxiv.size}`);
console.log(`Repos found: ${updates.length}`);
console.log(`papers rows updated: ${applied}`);
console.log(`Failures: ${failed}`);

const { count: papersWithHf } = await sb.from("papers").select("*", { count: "exact", head: true }).not("hf_repo", "is", null);
const { count: papersWithGh } = await sb.from("papers").select("*", { count: "exact", head: true }).not("github_repo", "is", null);
const { count: papersTotal } = await sb.from("papers").select("*", { count: "exact", head: true });
console.log(`\npapers coverage: ${papersTotal} total, ${papersWithHf} have hf_repo, ${papersWithGh} have github_repo`);

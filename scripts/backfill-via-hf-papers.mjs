// Strategy 4: For every paper in our `papers` table, hit the HuggingFace
// papers page. When indexed, HF surfaces the official model/dataset/space
// repo links + sometimes the GitHub repo. Often higher-confidence than
// abstract regex.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const HF_PATTERN = /\/(models|datasets|spaces)\/([\w-]+\/[\w.-]+)/gi;
const GH_PATTERN = /github\.com\/([\w-]+\/[\w.-]+)/gi;
function norm(r) { return r.replace(/[.,)\]\s]+$/, "").trim(); }

const { data: papers } = await sb.from("papers").select("arxiv_id, hf_repo, github_repo");
console.log(`HF papers backfill: ${papers.length} papers`);

let i = 0, indexed = 0, hfFound = 0, ghFound = 0;
const queue = [...papers];
async function worker() {
  while (queue.length) {
    const p = queue.shift();
    if (!p) break;
    i++;
    const id = p.arxiv_id.replace(/v\d+$/, "");
    try {
      const res = await fetch(`https://huggingface.co/papers/${id}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      indexed++;
      const html = await res.text();
      const update = {};
      if (!p.hf_repo) {
        const matches = [...html.matchAll(HF_PATTERN)].map((m) => norm(m[2]));
        const f = matches.filter((r) => !r.toLowerCase().startsWith("anonymous/"));
        const c = new Map();
        for (const r of f) c.set(r, (c.get(r) ?? 0) + 1);
        const winner = [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (winner) {
          update.hf_repo = winner;
          hfFound++;
        }
      }
      if (!p.github_repo) {
        const matches = [...html.matchAll(GH_PATTERN)].map((m) => norm(m[1]));
        const f = matches.filter((r) => !r.toLowerCase().startsWith("anonymous/"));
        const c = new Map();
        for (const r of f) c.set(r, (c.get(r) ?? 0) + 1);
        const winner = [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (winner) {
          update.github_repo = winner;
          ghFound++;
        }
      }
      if (Object.keys(update).length > 0) {
        await sb.from("papers").update(update).eq("arxiv_id", p.arxiv_id);
      }
    } catch {
      // skip
    }
    if (i % 25 === 0) process.stdout.write(`  ${i}/${papers.length} (indexed=${indexed}, hf+=${hfFound}, gh+=${ghFound})\r`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
process.stdout.write("\n");

console.log(`HF papers backfill: ${i} scanned, ${indexed} found on HF, hf+=${hfFound}, gh+=${ghFound}`);
const { count: hfTotal } = await sb.from("papers").select("*", { count: "exact", head: true }).not("hf_repo", "is", null);
const { count: ghTotal } = await sb.from("papers").select("*", { count: "exact", head: true }).not("github_repo", "is", null);
console.log(`papers coverage: ${hfTotal} hf_repo, ${ghTotal} github_repo`);

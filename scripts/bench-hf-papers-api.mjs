// Method B was the right idea but wrong parser. HF exposes a structured
// API at /api/papers/<arxiv_id> that returns the same data the rendered
// page uses — including, when present, the "Models citing this paper"
// list with verified owner links. No regex needed.
//
// Run: node scripts/bench-hf-papers-api.mjs

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

console.log("Loading 200 papers with abstracts...");
const { data: rows, error } = await sb
  .from("papers")
  .select("arxiv_id, abstract")
  .not("abstract", "is", null)
  .order("created_at", { ascending: false })
  .limit(200);
if (error) { console.error(error.message); process.exit(1); }
console.log(`  ${rows.length} papers`);

// HF's paper-info endpoint. Several known shapes — try in order:
//   /api/papers/<id>                  → main paper info
//   /api/papers/<id>/repo             → linked repo (if author claimed)
//   /api/datasets?paper=<id>          → datasets citing this paper
//   /api/models?paper=<id>            → models citing this paper
async function probe(arxivId) {
  const id = arxivId.replace(/v\d+$/, "");
  const out = { arxiv_id: arxivId, indexed: false, models: [], datasets: [], spaces: [], repo: null };
  try {
    const res = await fetch(`https://huggingface.co/api/papers/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      out.indexed = true;
      const j = await res.json();
      // Different fields appear depending on indexing; record whatever's present
      if (Array.isArray(j.models)) out.models = j.models.map((m) => m.id || m.modelId).filter(Boolean);
      if (Array.isArray(j.datasets)) out.datasets = j.datasets.map((d) => d.id).filter(Boolean);
      if (Array.isArray(j.spaces)) out.spaces = j.spaces.map((s) => s.id).filter(Boolean);
      if (j.repo?.url) out.repo = j.repo.url;
    }
  } catch { /* not indexed or transient error */ }
  // Also try the dedicated models endpoint — sometimes works when the
  // /api/papers/<id> body is sparse
  try {
    const res = await fetch(`https://huggingface.co/api/models?paper=${encodeURIComponent(id)}&limit=10`, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr)) {
        for (const m of arr) {
          const mid = m.id || m.modelId;
          if (mid && !out.models.includes(mid)) out.models.push(mid);
        }
      }
    }
  } catch { /* skip */ }
  return out;
}

const t0 = Date.now();
let idx = 0;
const results = rows.map((r) => ({ arxiv_id: r.arxiv_id }));
async function worker() {
  while (idx < rows.length) {
    const my = idx++;
    results[my] = await probe(rows[my].arxiv_id);
    if (my % 20 === 0) process.stdout.write(`  ${my}/${rows.length}\r`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
process.stdout.write("\n");
const tEnd = Date.now();

let indexed = 0, withModel = 0, withDataset = 0, withSpace = 0, withAnything = 0, withRepo = 0;
for (const r of results) {
  if (r.indexed) indexed++;
  if (r.models.length) withModel++;
  if (r.datasets.length) withDataset++;
  if (r.spaces.length) withSpace++;
  if (r.repo) withRepo++;
  if (r.models.length || r.datasets.length || r.spaces.length || r.repo) withAnything++;
}

console.log("\n=== HF PAPERS API RECALL ===");
console.log(`indexed by HF:       ${indexed}/200`);
console.log(`with linked model:   ${withModel}/200`);
console.log(`with linked dataset: ${withDataset}/200`);
console.log(`with linked space:   ${withSpace}/200`);
console.log(`with linked repo:    ${withRepo}/200`);
console.log(`with ANY artifact:   ${withAnything}/200 = ${Math.round(100*withAnything/200)}%`);
console.log(`time: ${tEnd-t0}ms = ${((tEnd-t0)/200).toFixed(0)}ms/paper`);

console.log("\n=== SAMPLES (10 with artifacts) ===");
let s = 0;
for (const r of results) {
  if (s >= 10) break;
  if (!(r.models.length || r.datasets.length || r.spaces.length || r.repo)) continue;
  console.log(`  ${r.arxiv_id}: models=[${r.models.slice(0,3).join(", ")}] datasets=[${r.datasets.slice(0,2).join(", ")}] repo=${r.repo || "-"}`);
  s++;
}

writeFileSync("/tmp/bench-hf-papers-api-results.json", JSON.stringify(results, null, 2));
console.log(`\nFull: /tmp/bench-hf-papers-api-results.json`);

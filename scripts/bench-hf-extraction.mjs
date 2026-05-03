// Benchmark: how well do we actually extract HF + GitHub repos for 200 real
// papers? Compares three signals against each other on the same papers:
//   (A) abstract regex            — extractFromText() in repo-extractor.ts
//   (B) huggingface.co/papers/<id> — extractFromHuggingFacePage()
//   (C) paperswithcode.com lookup  — NEW, not in repo today
//
// Output:
//   - per-method recall (% of papers where it found ≥1 repo)
//   - per-method overlap (Venn-style)
//   - sample wins where one method beats the others
//   - total time (so we know per-paper cost)

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Same regexes as src/lib/repo-extractor.ts so we benchmark what's actually
// running today, not a tweaked variant.
const HF_PATTERN = /(?:huggingface\.co\/(?:models?\/|datasets?\/|spaces\/)?)([\w-]+\/[\w.-]+)/gi;
const GH_PATTERN = /github\.com\/([\w-]+\/[\w.-]+)/gi;
const norm = (r) => r.replace(/[.,)\]\s]+$/, "").trim();
const FAMOUS_GH = new Set([
  "huggingface", "openai", "anthropic", "google", "google-research",
  "facebook", "facebookresearch", "microsoft", "deepmind", "meta",
  "meta-llama", "nvidia", "apple", "tencent", "baidu", "alibaba",
  "tensorflow", "pytorch", "pyg-team", "scikit-learn", "scipy", "numpy",
]);

function pickBest(matches, opts = {}) {
  if (!matches.length) return null;
  let f = matches.filter((r) => {
    const l = r.toLowerCase();
    if (l.startsWith("anonymous/") || l.startsWith("anon/")) return false;
    if (opts.kind === "gh") {
      const owner = l.split("/")[0];
      if (FAMOUS_GH.has(owner)) return false;
    }
    return true;
  });
  const c = new Map();
  for (const r of f) c.set(r, (c.get(r) ?? 0) + 1);
  const sorted = [...c.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}

function extract(text) {
  if (!text) return { hf: null, gh: null };
  const hf = pickBest([...text.matchAll(HF_PATTERN)].map((m) => norm(m[1])), { kind: "hf" });
  const gh = pickBest([...text.matchAll(GH_PATTERN)].map((m) => norm(m[1])), { kind: "gh" });
  return { hf, gh };
}

async function methodA_abstract(p) {
  return extract(p.abstract || "");
}

async function methodB_hfPage(p) {
  const id = p.arxiv_id.replace(/v\d+$/, "");
  try {
    const res = await fetch(`https://huggingface.co/papers/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { hf: null, gh: null, indexed: false };
    const html = await res.text();
    return { ...extract(html), indexed: true };
  } catch {
    return { hf: null, gh: null, indexed: false };
  }
}

// PaperWithCode hosts a per-paper page at /paper/<slug>. The slug isn't
// derivable from arxiv_id directly, but they expose a JSON endpoint:
//   /api/v1/papers/?arxiv_id=<id>
// Returns metadata + a `repository_url` if a repo is registered.
async function methodC_pwc(p) {
  const id = p.arxiv_id.replace(/v\d+$/, "");
  try {
    const res = await fetch(`https://paperswithcode.com/api/v1/papers/?arxiv_id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { hf: null, gh: null, indexed: false };
    const j = await res.json();
    const paper = j?.results?.[0];
    if (!paper) return { hf: null, gh: null, indexed: false };
    const pid = paper.id;
    if (!pid) return { hf: null, gh: null, indexed: true };
    // Now fetch that paper's repos endpoint
    const r2 = await fetch(`https://paperswithcode.com/api/v1/papers/${pid}/repositories/`, { signal: AbortSignal.timeout(10_000) });
    if (!r2.ok) return { hf: null, gh: null, indexed: true };
    const rj = await r2.json();
    const repos = rj?.results ?? [];
    const ghs = [];
    for (const r of repos) {
      const url = r.url || "";
      const m = url.match(/github\.com\/([\w-]+\/[\w.-]+)/i);
      if (m) ghs.push(norm(m[1]));
    }
    return { hf: null, gh: pickBest(ghs, { kind: "gh" }), indexed: true };
  } catch {
    return { hf: null, gh: null, indexed: false };
  }
}

// ---- Sample 200 papers across the abstract space ----
console.log("Loading 200 papers with abstracts (random-ish slice)...");
const { data: rows, error } = await sb
  .from("papers")
  .select("arxiv_id, abstract, hf_repo, github_repo")
  .not("abstract", "is", null)
  .order("created_at", { ascending: false })
  .limit(200);
if (error) { console.error(error.message); process.exit(1); }
console.log(`  loaded ${rows.length}`);

const t0 = Date.now();

// Run A inline (cheap), B + C with bounded concurrency
const results = rows.map((r) => ({ arxiv_id: r.arxiv_id }));

console.log("\nA: abstract regex...");
for (let i = 0; i < rows.length; i++) {
  const a = await methodA_abstract(rows[i]);
  results[i].A = a;
}
const tA = Date.now();

console.log(`B: huggingface.co/papers/<id> (concurrent 6)...`);
let bIdx = 0;
async function workerB() {
  while (bIdx < rows.length) {
    const my = bIdx++;
    const b = await methodB_hfPage(rows[my]);
    results[my].B = b;
    if (my % 20 === 0) process.stdout.write(`  ${my}/${rows.length}\r`);
  }
}
await Promise.all(Array.from({ length: 6 }, workerB));
process.stdout.write("\n");
const tB = Date.now();

console.log(`C: paperswithcode.com api (concurrent 4)...`);
let cIdx = 0;
async function workerC() {
  while (cIdx < rows.length) {
    const my = cIdx++;
    const c = await methodC_pwc(rows[my]);
    results[my].C = c;
    if (my % 20 === 0) process.stdout.write(`  ${my}/${rows.length}\r`);
  }
}
await Promise.all(Array.from({ length: 4 }, workerC));
process.stdout.write("\n");
const tC = Date.now();

// ---- Tally ----
function tally(method) {
  let hfHit = 0, ghHit = 0, anyHit = 0, indexed = 0;
  for (const r of results) {
    const m = r[method];
    if (!m) continue;
    if (m.indexed !== false) indexed++;
    if (m.hf) hfHit++;
    if (m.gh) ghHit++;
    if (m.hf || m.gh) anyHit++;
  }
  return { hfHit, ghHit, anyHit, indexed };
}

const a = tally("A"), b = tally("B"), c = tally("C");

console.log("\n=== RECALL OVER 200 PAPERS ===");
console.log(`A (abstract regex):        any=${a.anyHit}  hf=${a.hfHit}  gh=${a.ghHit}`);
console.log(`B (HF papers page):        any=${b.anyHit}  hf=${b.hfHit}  gh=${b.ghHit}  indexed=${b.indexed}`);
console.log(`C (PapersWithCode API):    any=${c.anyHit}  hf=${c.hfHit}  gh=${c.ghHit}  indexed=${c.indexed}`);

// Union recall
let unionAny = 0, onlyA = 0, onlyB = 0, onlyC = 0, allMissed = 0;
for (const r of results) {
  const ha = r.A?.hf || r.A?.gh;
  const hb = r.B?.hf || r.B?.gh;
  const hc = r.C?.hf || r.C?.gh;
  if (ha || hb || hc) unionAny++;
  if (ha && !hb && !hc) onlyA++;
  if (hb && !ha && !hc) onlyB++;
  if (hc && !ha && !hb) onlyC++;
  if (!ha && !hb && !hc) allMissed++;
}
console.log(`\nUNION (A∪B∪C):             any=${unionAny}/${rows.length}  (${Math.round(100*unionAny/rows.length)}%)`);
console.log(`Only-A wins:               ${onlyA}`);
console.log(`Only-B wins:               ${onlyB}`);
console.log(`Only-C wins:               ${onlyC}`);
console.log(`All three missed:          ${allMissed}`);

// HF-specific recall (the user's specific concern)
let hfA = 0, hfB = 0, hfC = 0, hfUnion = 0;
for (const r of results) {
  if (r.A?.hf) hfA++;
  if (r.B?.hf) hfB++;
  if (r.C?.hf) hfC++;
  if (r.A?.hf || r.B?.hf || r.C?.hf) hfUnion++;
}
console.log(`\n=== HF-SPECIFIC RECALL ===`);
console.log(`A hf:     ${hfA}/200`);
console.log(`B hf:     ${hfB}/200`);
console.log(`C hf:     ${hfC}/200`);
console.log(`Union hf: ${hfUnion}/200  (${Math.round(100*hfUnion/200)}%)`);

console.log(`\n=== TIME ===`);
console.log(`A: ${tA - t0}ms total = ${((tA - t0) / rows.length).toFixed(1)}ms/paper`);
console.log(`B: ${tB - tA}ms total = ${((tB - tA) / rows.length).toFixed(1)}ms/paper`);
console.log(`C: ${tC - tB}ms total = ${((tC - tB) / rows.length).toFixed(1)}ms/paper`);

// Show 10 sample disagreements so the user can eyeball false positives
console.log(`\n=== 10 SAMPLES (showing disagreements / wins) ===`);
let shown = 0;
for (const r of results) {
  if (shown >= 10) break;
  const ha = r.A?.hf || r.A?.gh;
  const hb = r.B?.hf || r.B?.gh;
  const hc = r.C?.hf || r.C?.gh;
  if ((ha ? 1 : 0) + (hb ? 1 : 0) + (hc ? 1 : 0) === 0) continue;
  if (ha && hb && hc) continue; // all agree, boring
  console.log(`  ${r.arxiv_id}`);
  console.log(`    A: hf=${r.A?.hf || "-"} gh=${r.A?.gh || "-"}`);
  console.log(`    B: hf=${r.B?.hf || "-"} gh=${r.B?.gh || "-"} indexed=${r.B?.indexed}`);
  console.log(`    C: hf=${r.C?.hf || "-"} gh=${r.C?.gh || "-"} indexed=${r.C?.indexed}`);
  shown++;
}

// Save full results so we can drill down
import { writeFileSync } from "node:fs";
writeFileSync("/tmp/bench-hf-results.json", JSON.stringify(results, null, 2));
console.log(`\nFull results: /tmp/bench-hf-results.json`);

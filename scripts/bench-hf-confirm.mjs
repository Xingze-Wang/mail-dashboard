// Precision check: take the extracted strings from bench-hf-extraction.mjs
// and confirm each one is a real HF/GH page (HTTP 200, not a reserved path,
// not 404). Reports per-method precision so we know whether the regex is
// finding actual repos or just noise.
//
// Run: node scripts/bench-hf-confirm.mjs

import { readFileSync, writeFileSync } from "node:fs";

const PATH = "/tmp/bench-hf-results.json";
let results;
try {
  results = JSON.parse(readFileSync(PATH, "utf8"));
} catch {
  console.error(`Run scripts/bench-hf-extraction.mjs first — ${PATH} not found`);
  process.exit(1);
}
console.log(`Loaded ${results.length} extraction results`);

// HF reserved tokens that look like "owner" but aren't real users.
const HF_RESERVED_OWNERS = new Set([
  "datasets", "spaces", "models", "papers", "blog", "docs", "pricing",
  "login", "join", "settings", "organizations", "new",
]);

// confirm a single GitHub "owner/repo" is reachable
async function checkGH(repo) {
  if (!repo) return { ok: null, reason: "none" };
  // Reject obvious noise from the regex
  if (repo.split("/").length !== 2) return { ok: false, reason: "bad-shape" };
  const url = `https://github.com/${repo}`;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
      headers: { "User-Agent": "qiji-bench/1.0" },
    });
    return { ok: res.status === 200, reason: `http-${res.status}` };
  } catch (e) {
    return { ok: false, reason: `err-${e.name || "unknown"}` };
  }
}

async function checkHF(repo) {
  if (!repo) return { ok: null, reason: "none" };
  if (repo.split("/").length !== 2) return { ok: false, reason: "bad-shape" };
  const owner = repo.split("/")[0].toLowerCase();
  if (HF_RESERVED_OWNERS.has(owner)) return { ok: false, reason: `reserved-${owner}` };
  // HF returns 200 for /<owner>/<name> if it's any kind of repo (model,
  // dataset, space). 404 if not. Use GET because some HF pages 405 on HEAD.
  const url = `https://huggingface.co/${repo}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
      headers: { "User-Agent": "qiji-bench/1.0" },
    });
    return { ok: res.status === 200, reason: `http-${res.status}` };
  } catch (e) {
    return { ok: false, reason: `err-${e.name || "unknown"}` };
  }
}

// Collect all extracted (paper, method, kind, repo) triples to confirm.
// De-dup the work so we don't HEAD the same popular repo dozens of times.
const seenGH = new Map(); // repo -> Promise<{ok,reason}>
const seenHF = new Map();
function memoGH(r) {
  if (!seenGH.has(r)) seenGH.set(r, checkGH(r));
  return seenGH.get(r);
}
function memoHF(r) {
  if (!seenHF.has(r)) seenHF.set(r, checkHF(r));
  return seenHF.get(r);
}

// Per-method tally
const methods = ["A", "B", "C"];
const tally = {
  A: { gh_extracted: 0, gh_ok: 0, gh_bad: 0, hf_extracted: 0, hf_ok: 0, hf_bad: 0 },
  B: { gh_extracted: 0, gh_ok: 0, gh_bad: 0, hf_extracted: 0, hf_ok: 0, hf_bad: 0 },
  C: { gh_extracted: 0, gh_ok: 0, gh_bad: 0, hf_extracted: 0, hf_ok: 0, hf_bad: 0 },
};
const samples = { gh_bad: [], hf_bad: [] };

console.log("Confirming extracted strings against github.com / huggingface.co...");
let processed = 0;
const total = results.length;

// Sequentialize per-paper but parallelize across papers via small worker pool
let idx = 0;
async function worker(workerId) {
  while (idx < total) {
    const my = idx++;
    const r = results[my];
    for (const m of methods) {
      const ext = r[m];
      if (!ext) continue;
      if (ext.gh) {
        tally[m].gh_extracted++;
        const v = await memoGH(ext.gh);
        if (v.ok) tally[m].gh_ok++;
        else { tally[m].gh_bad++; if (samples.gh_bad.length < 10) samples.gh_bad.push({ paper: r.arxiv_id, method: m, repo: ext.gh, reason: v.reason }); }
      }
      if (ext.hf) {
        tally[m].hf_extracted++;
        const v = await memoHF(ext.hf);
        if (v.ok) tally[m].hf_ok++;
        else { tally[m].hf_bad++; if (samples.hf_bad.length < 10) samples.hf_bad.push({ paper: r.arxiv_id, method: m, repo: ext.hf, reason: v.reason }); }
      }
    }
    processed++;
    if (processed % 20 === 0) process.stdout.write(`  ${processed}/${total}\r`);
  }
}
await Promise.all(Array.from({ length: 8 }, (_, i) => worker(i)));
process.stdout.write("\n");

console.log("\n=== PRECISION ===");
for (const m of methods) {
  const t = tally[m];
  const ghP = t.gh_extracted ? Math.round((100 * t.gh_ok) / t.gh_extracted) : 0;
  const hfP = t.hf_extracted ? Math.round((100 * t.hf_ok) / t.hf_extracted) : 0;
  console.log(`${m}: gh extracted=${t.gh_extracted}  ok=${t.gh_ok}  bad=${t.gh_bad}  precision=${ghP}%`);
  console.log(`   hf extracted=${t.hf_extracted}  ok=${t.hf_ok}  bad=${t.hf_bad}  precision=${hfP}%`);
}

console.log("\n=== UNIQUE STRINGS CHECKED ===");
console.log(`gh: ${seenGH.size} unique`);
console.log(`hf: ${seenHF.size} unique`);

console.log("\n=== SAMPLE BAD GH ===");
for (const s of samples.gh_bad) console.log(` ${s.paper} via ${s.method} -> github.com/${s.repo} (${s.reason})`);
console.log("\n=== SAMPLE BAD HF ===");
for (const s of samples.hf_bad) console.log(` ${s.paper} via ${s.method} -> huggingface.co/${s.repo} (${s.reason})`);

writeFileSync("/tmp/bench-hf-confirm.json", JSON.stringify({ tally, samples }, null, 2));
console.log(`\nFull tally: /tmp/bench-hf-confirm.json`);

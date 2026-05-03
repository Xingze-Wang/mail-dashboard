// Agent 18 — hf-papers for slice-18 only.
// Mirrors strategyHfPapers in scripts/enrich-net.mjs but iterates the
// pre-sliced item list rather than re-querying every paper from the DB.
// Idempotent: only writes hf_repo / github_repo when they're currently null.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync } from "node:fs";

const SLICE_PATH = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/slice-18.json";
const SUMMARY_PATH = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/summary.jsonl";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const HF_PATTERN = /\/(models|datasets|spaces)\/([\w-]+\/[\w.-]+)/g;
const GH_PATTERN = /github\.com\/([\w-]+\/[\w.-]+)/gi;

function normRepo(r) { return r.replace(/[.,)\]\s]+$/, "").trim(); }
function pickRepo(arr) {
  const f = arr.filter((r) => !r.toLowerCase().startsWith("anonymous/"));
  const c = new Map();
  for (const r of f) c.set(r, (c.get(r) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const slice = JSON.parse(readFileSync(SLICE_PATH, "utf8"));
const items = slice.items;
const start = Date.now();
console.log(`agent ${slice.agent} (hf-papers): ${items.length} papers`);

const queue = [...items];
let processed = 0;
let indexed = 0;
let hfFound = 0;
let ghFound = 0;
let errors = 0;
const CONC = 6;

async function worker() {
  while (queue.length) {
    const p = queue.shift();
    if (!p) break;
    processed++;
    const id = p.arxiv_id.replace(/v\d+$/, "");
    try {
      const res = await fetch(`https://huggingface.co/papers/${id}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status !== 404) errors++;
        continue;
      }
      indexed++;
      const html = await res.text();
      const update = {};
      if (!p.hf_repo) {
        const m = pickRepo([...html.matchAll(HF_PATTERN)].map((mm) => normRepo(mm[2])));
        if (m) { update.hf_repo = m; hfFound++; }
      }
      if (!p.github_repo) {
        const m = pickRepo([...html.matchAll(GH_PATTERN)].map((mm) => normRepo(mm[1])));
        if (m) { update.github_repo = m; ghFound++; }
      }
      if (Object.keys(update).length > 0) {
        const { error } = await sb.from("papers").update(update).eq("arxiv_id", p.arxiv_id);
        if (error) errors++;
      }
    } catch {
      errors++;
    }
    if (processed % 25 === 0) {
      process.stdout.write(`  ${processed}/${items.length} (indexed=${indexed}, hf+=${hfFound}, gh+=${ghFound}, err=${errors})\r`);
    }
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write("\n");

const duration_ms = Date.now() - start;
const wins = hfFound + ghFound;
const summary = {
  agent: String(slice.agent),
  strategy: "hf-papers",
  scanned: processed,
  wins,
  errors,
  new_persons: 0,
  duration_ms,
  indexed,
  hf_found: hfFound,
  gh_found: ghFound,
};
console.log(JSON.stringify(summary));
appendFileSync(SUMMARY_PATH, JSON.stringify(summary) + "\n");

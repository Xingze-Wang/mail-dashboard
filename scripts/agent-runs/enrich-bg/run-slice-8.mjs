// Agent 8 — resolve-titles slice runner.
// Mirrors strategyResolveTitles in scripts/enrich-net.mjs but only over the
// titles in slice-8.json. Writes a JSONL summary line on completion.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync } from "node:fs";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SLICE_PATH = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/slice-8.json";
const SUMMARY_PATH = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/summary.jsonl";

const slice = JSON.parse(readFileSync(SLICE_PATH, "utf8"));
const { agent, strategy, items } = slice;
console.log(`agent=${agent} strategy=${strategy} items=${items.length}`);

const start = Date.now();
const queue = items.slice();
const total = queue.length;
let scanned = 0, wins = 0, errors = 0;

const CONC = 5;

async function worker() {
  while (queue.length) {
    const title = queue.shift();
    if (!title) break;
    scanned++;
    try {
      const url = `${S2_BASE}/paper/search/match?query=${encodeURIComponent(title.slice(0, 500))}&fields=title,externalIds`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const j = await res.json();
        const first = j.data?.[0];
        const arxiv = first?.externalIds?.ArXiv;
        if (arxiv) {
          wins++;
          // upsert paper, then link history rows that match this title
          const { error: upsertErr } = await sb
            .from("papers")
            .upsert({ arxiv_id: arxiv, title: first.title }, { onConflict: "arxiv_id" });
          if (upsertErr) errors++;
          const { error: updErr } = await sb
            .from("email_contact_history")
            .update({ paper_arxiv_id: arxiv })
            .ilike("paper_title", title)
            .is("paper_arxiv_id", null);
          if (updErr) errors++;
        }
      } else if (res.status !== 404) {
        // 404 = no match; not an error. Other non-OK: bump errors.
        errors++;
      }
    } catch {
      errors++;
    }
    if (scanned % 25 === 0) {
      process.stdout.write(`  ${scanned}/${total} (wins=${wins}, errors=${errors})\r`);
    }
    await sleep(220); // S2 rate limit hygiene
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write("\n");

const duration_ms = Date.now() - start;
const summary = {
  agent: String(agent),
  strategy,
  scanned,
  wins,
  errors,
  new_persons: 0,
  duration_ms,
};
appendFileSync(SUMMARY_PATH, JSON.stringify(summary) + "\n");
console.log(`done: scanned=${scanned} wins=${wins} errors=${errors} duration_ms=${duration_ms}`);

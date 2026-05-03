// Agent 5 — resolve-titles for its slice only.
// Mirrors strategyResolveTitles in scripts/enrich-net.mjs but scoped to the
// slice file's titles (idempotent: only writes when paper_arxiv_id is null).

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg";
const slicePath = path.join(dir, "slice-5.json");
const summaryPath = path.join(dir, "summary.jsonl");
const slice = JSON.parse(fs.readFileSync(slicePath, "utf8"));

const t0 = Date.now();
const titles = [...new Set((slice.items ?? []).map((t) => String(t).trim()).filter(Boolean))];
console.log(`agent=${slice.agent} strategy=${slice.strategy} titles=${titles.length}`);

let i = 0, wins = 0, errors = 0;
const queue = titles.slice();
const CONC = 5;

async function worker() {
  while (queue.length) {
    const title = queue.shift();
    if (!title) break;
    i++;
    try {
      const url = `${S2_BASE}/paper/search/match?query=${encodeURIComponent(title.slice(0, 500))}&fields=title,externalIds`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 429) {
        // rate limited — back off and requeue
        queue.push(title);
        i--;
        await sleep(2500);
        continue;
      }
      if (res.ok) {
        const j = await res.json();
        const first = j.data?.[0];
        const arxiv = first?.externalIds?.ArXiv;
        if (arxiv) {
          wins++;
          const { error: upErr } = await sb
            .from("papers")
            .upsert({ arxiv_id: arxiv, title: first.title }, { onConflict: "arxiv_id" });
          if (upErr) errors++;
          const { error: hErr } = await sb
            .from("email_contact_history")
            .update({ paper_arxiv_id: arxiv })
            .ilike("paper_title", title)
            .is("paper_arxiv_id", null);
          if (hErr) errors++;
        }
      } else if (res.status >= 500) {
        errors++;
      }
    } catch {
      errors++;
    }
    if (i % 25 === 0) {
      process.stdout.write(`  ${i}/${titles.length} (wins=${wins}, errors=${errors})\r`);
    }
    await sleep(220);
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write("\n");

const duration_ms = Date.now() - t0;
console.log(`done: scanned=${i} wins=${wins} errors=${errors} duration_ms=${duration_ms}`);

const summary = {
  agent: String(slice.agent),
  strategy: slice.strategy,
  scanned: i,
  wins,
  errors,
  new_persons: 0,
  duration_ms,
};
fs.appendFileSync(summaryPath, JSON.stringify(summary) + "\n");
console.log("summary appended:", summary);

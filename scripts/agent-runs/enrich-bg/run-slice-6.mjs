// Agent 6 — resolve-titles on slice-6 only.
// Mirrors strategyResolveTitles in scripts/enrich-net.mjs but iterates only
// the titles in our slice file.

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

const sliceFile = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/slice-6.json";
const summaryFile = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/summary.jsonl";

const slice = JSON.parse(fs.readFileSync(sliceFile, "utf8"));
const titles = slice.items.map((t) => t.trim()).filter(Boolean);

console.log(`agent ${slice.agent} (${slice.strategy}) — ${titles.length} titles`);

const t0 = Date.now();
let scanned = 0;
let wins = 0;
let errors = 0;
const queue = [...titles];
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
          await sb.from("papers").upsert({ arxiv_id: arxiv, title: first.title }, { onConflict: "arxiv_id" });
          await sb
            .from("email_contact_history")
            .update({ paper_arxiv_id: arxiv })
            .ilike("paper_title", title)
            .is("paper_arxiv_id", null);
        }
      } else if (res.status !== 404) {
        errors++;
      }
    } catch (e) {
      errors++;
    }
    if (scanned % 25 === 0) {
      process.stdout.write(`  ${scanned}/${titles.length} (wins=${wins}, err=${errors})\r`);
    }
    await sleep(200);
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write("\n");

const duration_ms = Date.now() - t0;
const summary = {
  agent: String(slice.agent),
  strategy: slice.strategy,
  scanned,
  wins,
  errors,
  new_persons: 0,
  duration_ms,
};
console.log("summary:", summary);

fs.appendFileSync(summaryFile, JSON.stringify(summary) + "\n");
console.log(`appended to ${path.basename(summaryFile)}`);

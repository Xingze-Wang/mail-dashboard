// Resolve titles → arxiv_id for ONE slice file.
//
// Usage:
//   TAVILY_API_KEY=... node scripts/agent-runs/enrich-bg/resolve-slice.mjs <agent-num>
//
// Reads slice-{N}.json, tries S2 → arxiv → Tavily for each title.
// Idempotent: skips titles that already have a paper_arxiv_id in
// email_contact_history.
// Appends a one-line summary to summary.jsonl.

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const TAVILY_KEY = process.env.TAVILY_API_KEY ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARXIV_RE = /(\d{4}\.\d{4,5})(?:v\d+)?/;

const agentNum = parseInt(process.argv[2] ?? "2", 10);
const sliceDir = path.dirname(new URL(import.meta.url).pathname);
const slicePath = path.join(sliceDir, `slice-${agentNum}.json`);
const summaryPath = path.join(sliceDir, "summary.jsonl");

const slice = JSON.parse(fs.readFileSync(slicePath, "utf8"));
const titles = slice.items;
console.log(`agent ${agentNum}: ${titles.length} titles to resolve`);

// Idempotency: skip titles already linked.
async function alreadyResolved(title) {
  const { data } = await sb
    .from("email_contact_history")
    .select("paper_arxiv_id")
    .ilike("paper_title", title)
    .not("paper_arxiv_id", "is", null)
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

// ─── Resolution attempts ─────────────────────────────────────────────────

async function tryS2(title) {
  try {
    const url = `${S2_BASE}/paper/search/match?query=${encodeURIComponent(title.slice(0, 500))}&fields=title,externalIds`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = await res.json();
    const first = j.data?.[0];
    const arxiv = first?.externalIds?.ArXiv;
    if (arxiv && first?.title) {
      // Loose validation: title similarity (first 30 chars normalized)
      const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
      if (norm(first.title) === norm(title) || norm(first.title).startsWith(norm(title).slice(0, 20))) {
        return { arxiv_id: arxiv, title: first.title, source: "s2" };
      }
    }
  } catch { /* skip */ }
  return null;
}

async function tryArxiv(title) {
  try {
    // arXiv API returns Atom XML
    const url = `https://export.arxiv.org/api/query?search_query=ti:${encodeURIComponent('"' + title.slice(0, 200) + '"')}&max_results=3`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const xml = await res.text();
    // Pull first <entry> id+title
    const entries = xml.split(/<entry>/).slice(1);
    for (const e of entries) {
      const idMatch = e.match(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/);
      const titleMatch = e.match(/<title>([\s\S]*?)<\/title>/);
      if (!idMatch || !titleMatch) continue;
      const rawId = idMatch[1].trim();
      const m = rawId.match(ARXIV_RE);
      if (!m) continue;
      const arxiv = m[1];
      const respTitle = titleMatch[1].replace(/\s+/g, " ").trim();
      const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const a = norm(title), b = norm(respTitle);
      // require strong overlap
      if (a.length > 20 && (b.startsWith(a.slice(0, 25)) || a.startsWith(b.slice(0, 25)))) {
        return { arxiv_id: arxiv, title: respTitle, source: "arxiv" };
      }
    }
  } catch { /* skip */ }
  return null;
}

async function tryTavily(title) {
  if (!TAVILY_KEY) return null;
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query: `"${title}" arxiv`,
        search_depth: "basic",
        max_results: 5,
        include_domains: ["arxiv.org", "huggingface.co"],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const target = norm(title).slice(0, 30);
    for (const r of j.results ?? []) {
      const url = r.url ?? "";
      const snippet = `${r.title ?? ""} ${r.content ?? ""}`;
      const m = url.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/) || snippet.match(ARXIV_RE);
      if (!m) continue;
      const arxiv = m[1];
      // Check that the snippet/title contains the target
      if (norm(r.title ?? "").includes(target.slice(0, 20)) || norm(r.content ?? "").includes(target.slice(0, 20))) {
        return { arxiv_id: arxiv, title: r.title || title, source: "tavily" };
      }
    }
  } catch { /* skip */ }
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────

const t0 = Date.now();
let scanned = 0, wins = 0, errors = 0, skipped = 0;
const sourceCounts = { s2: 0, arxiv: 0, tavily: 0 };

const queue = [...titles];
const CONC = 4;
const newPersons = 0; // resolve-titles never inserts persons

async function worker() {
  while (queue.length) {
    const title = queue.shift();
    if (!title) break;
    scanned++;
    try {
      if (await alreadyResolved(title)) {
        skipped++;
        continue;
      }
      let hit = await tryS2(title);
      if (!hit) {
        await sleep(300);
        hit = await tryArxiv(title);
      }
      if (!hit) {
        await sleep(300);
        hit = await tryTavily(title);
      }
      if (hit) {
        wins++;
        sourceCounts[hit.source]++;
        // Upsert paper, link history
        await sb.from("papers").upsert(
          { arxiv_id: hit.arxiv_id, title: hit.title },
          { onConflict: "arxiv_id" },
        );
        await sb
          .from("email_contact_history")
          .update({ paper_arxiv_id: hit.arxiv_id })
          .ilike("paper_title", title)
          .is("paper_arxiv_id", null);
      }
    } catch (e) {
      errors++;
    }
    if (scanned % 10 === 0) {
      process.stdout.write(
        `  ${scanned}/${titles.length} (wins=${wins} s2=${sourceCounts.s2} ax=${sourceCounts.arxiv} tv=${sourceCounts.tavily} skip=${skipped} err=${errors})\r`,
      );
    }
    await sleep(250); // polite
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write("\n");

const duration_ms = Date.now() - t0;
const summary = {
  agent: String(agentNum),
  strategy: "resolve-titles",
  scanned,
  wins,
  errors,
  new_persons: newPersons,
  duration_ms,
  skipped,
  by_source: sourceCounts,
};
console.log("DONE", summary);
fs.appendFileSync(summaryPath, JSON.stringify(summary) + "\n");
process.exit(0);

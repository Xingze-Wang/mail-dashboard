// Agent 3 — resolve-titles for slice-3.json
// Strategy: S2 first → arxiv search → Tavily fallback
// Idempotent: skips titles already resolved in email_contact_history;
// only writes when arxiv_id found.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync } from "node:fs";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

// Load Tavily key from .env.local
let TAVILY_API_KEY = process.env.TAVILY_API_KEY;
if (!TAVILY_API_KEY) {
  try {
    const env = readFileSync("/Users/xingzewang/Desktop/mail/.env.local", "utf8");
    const m = env.match(/TAVILY_API_KEY="?([^"\n]+)"?/);
    if (m) TAVILY_API_KEY = m[1];
  } catch {}
}

const SLICE_PATH = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/slice-3.json";
const SUMMARY_PATH = "/Users/xingzewang/Desktop/mail/scripts/agent-runs/enrich-bg/summary.jsonl";
const slice = JSON.parse(readFileSync(SLICE_PATH, "utf8"));
const { agent, strategy, items } = slice;
console.log(`agent=${agent} strategy=${strategy} items=${items.length} tavily=${TAVILY_API_KEY ? "yes" : "no"}`);

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const ARXIV_API = "http://export.arxiv.org/api/query";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARXIV_RE = /(\d{4}\.\d{4,5})(?:v\d+)?/;

function normalizeTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function tokenJaccard(a, b) {
  const A = new Set(normalizeTitle(a).split(" ").filter((x) => x.length > 2));
  const B = new Set(normalizeTitle(b).split(" ").filter((x) => x.length > 2));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

async function tryS2(title) {
  try {
    const url = `${S2_BASE}/paper/search/match?query=${encodeURIComponent(title.slice(0, 500))}&fields=title,externalIds`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = await res.json();
    const first = j.data?.[0];
    if (!first) return null;
    const sim = tokenJaccard(title, first.title || "");
    if (sim < 0.6) return null;
    const arxiv = first.externalIds?.ArXiv;
    if (!arxiv) return null;
    return { arxiv_id: arxiv, title: first.title, source: "s2" };
  } catch {
    return null;
  }
}

async function tryArxiv(title) {
  try {
    const q = `ti:${JSON.stringify(title.slice(0, 250)).replace(/^"|"$/g, "")}`;
    const url = `${ARXIV_API}?search_query=${encodeURIComponent(q)}&start=0&max_results=3`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const xml = await res.text();
    // entries
    const entries = xml.split("<entry>").slice(1);
    for (const e of entries) {
      const idM = e.match(/<id>([^<]+)<\/id>/);
      const ttM = e.match(/<title>([\s\S]+?)<\/title>/);
      if (!idM || !ttM) continue;
      const candTitle = ttM[1].replace(/\s+/g, " ").trim();
      const sim = tokenJaccard(title, candTitle);
      if (sim < 0.6) continue;
      const am = idM[1].match(/abs\/(\d{4}\.\d{4,5})/);
      if (!am) continue;
      return { arxiv_id: am[1], title: candTitle, source: "arxiv" };
    }
    return null;
  } catch {
    return null;
  }
}

async function tryTavily(title) {
  if (!TAVILY_API_KEY) return null;
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: `"${title}" arxiv`,
        search_depth: "basic",
        max_results: 5,
        include_domains: ["arxiv.org"],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    for (const r of (j.results ?? [])) {
      const url = r.url || "";
      const m = url.match(/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/) || url.match(/arxiv\.org\/pdf\/(\d{4}\.\d{4,5})/);
      if (!m) continue;
      // Sanity check title similarity if present
      const candTitle = r.title || "";
      const sim = candTitle ? tokenJaccard(title, candTitle.replace(/\[.*?\]\s*/g, "")) : 1;
      if (sim < 0.4) continue;
      return { arxiv_id: m[1], title: candTitle.replace(/\s*-\s*arxiv.*$/i, "").trim() || title, source: "tavily" };
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveOne(title) {
  let hit = await tryS2(title);
  if (hit) return hit;
  await sleep(150);
  hit = await tryArxiv(title);
  if (hit) return hit;
  await sleep(150);
  hit = await tryTavily(title);
  return hit;
}

async function alreadyResolved(title) {
  // Idempotent: if any matching ehc row already has paper_arxiv_id, skip.
  const { data } = await sb
    .from("email_contact_history")
    .select("paper_arxiv_id")
    .ilike("paper_title", title)
    .not("paper_arxiv_id", "is", null)
    .limit(1);
  return data && data.length > 0;
}

const t0 = Date.now();
let scanned = 0, wins = 0, errors = 0, skipped = 0;
const bySrc = { s2: 0, arxiv: 0, tavily: 0 };

const queue = [...items];
const CONC = 4;

async function worker(id) {
  while (queue.length) {
    const title = queue.shift();
    if (!title) break;
    scanned++;
    try {
      if (await alreadyResolved(title)) { skipped++; continue; }
      const hit = await resolveOne(title);
      if (hit) {
        wins++;
        bySrc[hit.source] = (bySrc[hit.source] ?? 0) + 1;
        // Upsert paper
        const { error: e1 } = await sb
          .from("papers")
          .upsert({ arxiv_id: hit.arxiv_id, title: hit.title }, { onConflict: "arxiv_id" });
        if (e1) errors++;
        // Backfill all matching ehc rows
        const { error: e2 } = await sb
          .from("email_contact_history")
          .update({ paper_arxiv_id: hit.arxiv_id })
          .ilike("paper_title", title)
          .is("paper_arxiv_id", null);
        if (e2) errors++;
      }
    } catch (err) {
      errors++;
    }
    if (scanned % 10 === 0) {
      process.stdout.write(`  [w${id}] scanned=${scanned}/${items.length} wins=${wins} (s2=${bySrc.s2 ?? 0} arxiv=${bySrc.arxiv ?? 0} tavily=${bySrc.tavily ?? 0}) skip=${skipped} err=${errors}\r`);
    }
    await sleep(220);
  }
}

await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i + 1)));
process.stdout.write("\n");

const duration_ms = Date.now() - t0;
const summary = {
  agent: String(agent),
  strategy,
  scanned,
  wins,
  errors,
  new_persons: 0,
  duration_ms,
  by_source: bySrc,
  skipped_already_resolved: skipped,
};
console.log("DONE", summary);
appendFileSync(SUMMARY_PATH, JSON.stringify(summary) + "\n");
process.exit(0);

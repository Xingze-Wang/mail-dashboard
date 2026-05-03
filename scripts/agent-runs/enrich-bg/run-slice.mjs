// Custom resolve-titles runner for one slice.
// Uses BOTH S2 (paper/search/match) AND arxiv search in parallel,
// taking whichever returns a valid arxiv_id first. Tavily is the 3rd
// fallback if TAVILY_API_KEY is set.
//
// Idempotent: only writes email_contact_history.paper_arxiv_id where IS NULL.
//
// Usage: node run-slice.mjs <slice_path>

import { createClient } from "@supabase/supabase-js";
import { readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

const slicePath = process.argv[2];
if (!slicePath) { console.error("usage: run-slice.mjs <slice_path>"); process.exit(1); }
const slice = JSON.parse(readFileSync(slicePath, "utf8"));
const TAVILY_KEY = process.env.TAVILY_API_KEY ?? "";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const SUMMARY_PATH = resolve(slicePath, "..", "summary.jsonl");

// ─── normalization & similarity ─────────────────────────────────────────
function norm(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
function tokens(s) { return new Set(norm(s).split(" ").filter((x) => x.length > 2)); }
function similar(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}
function looksLikeArxivId(s) {
  if (!s) return false;
  // arxiv ids: 4digits.4-5digits, optional vN
  return /^\d{4}\.\d{4,5}(v\d+)?$/.test(s);
}

// ─── strategy A: S2 paper/search/match ──────────────────────────────────
async function fetchS2Match(title) {
  try {
    const url = `${S2_BASE}/paper/search/match?query=${encodeURIComponent(title.slice(0, 500))}&fields=title,externalIds`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = await res.json();
    const first = j.data?.[0];
    if (!first) return null;
    const arxiv = first.externalIds?.ArXiv;
    if (!arxiv) return null;
    const sim = similar(title, first.title || "");
    if (sim < 0.5) return null; // sanity: must be a believable match
    return { source: "s2-match", arxiv_id: arxiv, title: first.title, sim };
  } catch { return null; }
}

// fallback variant of S2: paper/search (full search)
async function fetchS2Search(title) {
  try {
    const url = `${S2_BASE}/paper/search?query=${encodeURIComponent(title.slice(0, 300))}&limit=3&fields=title,externalIds`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = await res.json();
    for (const cand of (j.data ?? [])) {
      const arxiv = cand.externalIds?.ArXiv;
      if (!arxiv) continue;
      const sim = similar(title, cand.title || "");
      if (sim >= 0.6) return { source: "s2-search", arxiv_id: arxiv, title: cand.title, sim };
    }
    return null;
  } catch { return null; }
}

// ─── strategy B: arxiv search API ───────────────────────────────────────
function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
async function fetchArxivSearch(title) {
  try {
    // ti: queries the title field. quote-escape the title.
    const q = `ti:${title.replace(/"/g, "")}`;
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&max_results=3`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const xml = await res.text();
    // parse entries quickly: pull <entry>…<id>…</id>…<title>…</title>
    const entries = xml.split("<entry>").slice(1);
    for (const e of entries) {
      const idM = e.match(/<id>([^<]+)<\/id>/);
      const tM = e.match(/<title>([\s\S]*?)<\/title>/);
      if (!idM || !tM) continue;
      const arxivUrl = idM[1].trim();
      const candTitle = decodeXmlEntities(tM[1]).replace(/\s+/g, " ").trim();
      // arxivUrl looks like http://arxiv.org/abs/2401.12345v1
      const m = arxivUrl.match(/abs\/([\d.]+(?:v\d+)?)/);
      if (!m) continue;
      const arxiv = m[1].replace(/v\d+$/, "");
      if (!looksLikeArxivId(arxiv)) continue;
      const sim = similar(title, candTitle);
      if (sim >= 0.6) return { source: "arxiv", arxiv_id: arxiv, title: candTitle, sim };
    }
    return null;
  } catch { return null; }
}

// ─── strategy C: Tavily fallback ────────────────────────────────────────
async function fetchTavily(title) {
  if (!TAVILY_KEY) return null;
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query: `arxiv "${title}"`,
        search_depth: "basic",
        max_results: 5,
        include_domains: ["arxiv.org"],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    for (const r of (j.results ?? [])) {
      const u = r.url || "";
      // pull arxiv id out of url
      const m = u.match(/arxiv\.org\/(?:abs|pdf)\/([\d.]+)(?:v\d+)?/);
      if (!m) continue;
      const arxiv = m[1];
      if (!looksLikeArxivId(arxiv)) continue;
      const sim = Math.max(similar(title, r.title || ""), similar(title, r.content || ""));
      if (sim < 0.4) continue;
      return { source: "tavily", arxiv_id: arxiv, title: r.title || title, sim };
    }
    return null;
  } catch { return null; }
}

// ─── race S2 + arxiv (whichever returns a valid hit first) ──────────────
function raceFirstHit(promises) {
  // Resolves with first non-null result, or null if all return null
  return new Promise((resolve) => {
    let pending = promises.length;
    let settled = false;
    if (pending === 0) return resolve(null);
    promises.forEach((p) => {
      p.then((v) => {
        if (settled) return;
        if (v) { settled = true; resolve(v); return; }
        pending--;
        if (pending === 0 && !settled) { settled = true; resolve(null); }
      }).catch(() => {
        pending--;
        if (pending === 0 && !settled) { settled = true; resolve(null); }
      });
    });
  });
}

async function resolveOne(title) {
  // First race s2-match + arxiv. Either-or; fastest wins.
  let hit = await raceFirstHit([fetchS2Match(title), fetchArxivSearch(title)]);
  // If neither hit, try the broader s2-search
  if (!hit) hit = await fetchS2Search(title);
  // If still nothing, Tavily fallback
  if (!hit) hit = await fetchTavily(title);
  return hit;
}

// ─── DB writes ──────────────────────────────────────────────────────────
async function applyHit(originalTitle, hit) {
  // Upsert papers row (arxiv_id is the PK / unique)
  await sb.from("papers").upsert(
    { arxiv_id: hit.arxiv_id, title: hit.title || originalTitle },
    { onConflict: "arxiv_id" },
  );
  // Update email_contact_history rows where paper_title matches AND paper_arxiv_id IS NULL
  const { error } = await sb
    .from("email_contact_history")
    .update({ paper_arxiv_id: hit.arxiv_id })
    .ilike("paper_title", originalTitle)
    .is("paper_arxiv_id", null);
  if (error) throw error;
}

// ─── main ───────────────────────────────────────────────────────────────
const t0 = Date.now();
const items = slice.items ?? [];
let scanned = 0, wins = 0, errors = 0;
const sourceTallies = {};

const CONC = 6;
const queue = [...items];
async function worker(workerId) {
  while (queue.length) {
    const title = queue.shift();
    if (!title) break;
    scanned++;
    try {
      const hit = await resolveOne(title);
      if (hit && hit.arxiv_id) {
        try {
          await applyHit(title, hit);
          wins++;
          sourceTallies[hit.source] = (sourceTallies[hit.source] ?? 0) + 1;
          process.stdout.write(`[w${workerId}] ${scanned}/${items.length} OK ${hit.source} ${hit.arxiv_id} sim=${hit.sim.toFixed(2)}\n`);
        } catch (e) {
          errors++;
          process.stdout.write(`[w${workerId}] ${scanned}/${items.length} DB-ERR ${e.message}\n`);
        }
      } else if (scanned % 10 === 0) {
        process.stdout.write(`[w${workerId}] ${scanned}/${items.length} (wins=${wins})\n`);
      }
    } catch (e) {
      errors++;
    }
    await sleep(150); // light politeness across all workers
  }
}

await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i + 1)));

const duration_ms = Date.now() - t0;
const summary = {
  agent: String(slice.agent ?? "?"),
  strategy: slice.strategy ?? "resolve-titles",
  scanned,
  wins,
  errors,
  new_persons: 0,
  duration_ms,
  sources: sourceTallies,
};
appendFileSync(SUMMARY_PATH, JSON.stringify(summary) + "\n");
console.log("\n=== DONE ===");
console.log(JSON.stringify(summary, null, 2));

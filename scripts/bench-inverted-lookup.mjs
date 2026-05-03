// Inverted approach: instead of regex'ing paper text for HF/GH links, start
// from what we KNOW about the person (name + email) and ask HF/GitHub
// directly whether that person exists.
//
// Two probes:
//   D — HF search by author name. /api/models?author=<name>&limit=5
//       → if any model exists under that exact author handle, that handle
//         IS the author's HF account (HF requires you to own the namespace).
//       Limitation: matches the *handle* literally, so we have to try a
//       few normalizations (full name, surname-firstname, lowercase).
//
//   E — GitHub commit search by author email. /search/commits?q=author-email:<e>
//       → if any commit was made with that email, the commit's author.login
//         is that person's GitHub username (verified by email ownership).
//       Limitation: requires GitHub auth (anonymous gives 422). Skip if
//       GH_TOKEN not set, but log how many we WOULD have tried.
//
// Sample = 200 papers from the bench, take the first author + first email
// per paper.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const GH_TOKEN = process.env.GITHUB_TOKEN || null;

// ---- Sample: 200 leads with both an author_name and author_email so we can
//      test both probes on the same row ----
console.log("Loading 200 pipeline_leads with name + email...");
const { data: leads, error } = await sb
  .from("pipeline_leads")
  .select("arxiv_id, author_name, author_email, first_name")
  .not("author_name", "is", null)
  .not("author_email", "is", null)
  .order("created_at", { ascending: false })
  .limit(200);
if (error) { console.error(error.message); process.exit(1); }
console.log(`  ${leads.length} leads`);

// ---- D: HF search by author name ----
//
// HF handle conventions vary (Wei-Zhang, weizhang, wzhang, ZhangWei, ...).
// Try a few normalizations of the name and pick the first one that returns
// a 200 with any model.
function nameVariants(authorName) {
  if (!authorName) return [];
  const cleaned = authorName.normalize("NFKD").replace(/[^a-zA-Z\s\-]/g, "").trim();
  if (!cleaned) return [];
  const parts = cleaned.split(/\s+/);
  if (parts.length < 2) return [cleaned.toLowerCase()];
  const [first, ...rest] = parts;
  const last = rest[rest.length - 1];
  return [
    `${first}-${last}`,                  // Wei-Zhang
    `${first}${last}`,                   // WeiZhang
    `${first.toLowerCase()}${last.toLowerCase()}`,  // weizhang
    `${first[0].toLowerCase()}${last.toLowerCase()}`, // wzhang
    `${last.toLowerCase()}${first[0].toLowerCase()}`, // zhangw
    `${last}-${first}`,                  // Zhang-Wei
  ];
}

async function probeHF(authorName) {
  const variants = nameVariants(authorName);
  for (const handle of variants) {
    try {
      const res = await fetch(
        `https://huggingface.co/api/models?author=${encodeURIComponent(handle)}&limit=1`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) continue;
      const arr = await res.json();
      if (Array.isArray(arr) && arr.length > 0) {
        // Confirm by hitting the user page
        const ures = await fetch(`https://huggingface.co/${handle}`, { signal: AbortSignal.timeout(8_000) });
        if (ures.ok) return { handle, modelId: arr[0]?.id || null };
      }
    } catch { /* try next variant */ }
  }
  return null;
}

// ---- E: GitHub commit search by email ----
//
// GitHub's /search/commits returns repos where `<email>` appears as a
// committer. Requires accept: cloak-preview header AND auth. Without auth,
// we skip this probe.
// GitHub's /search/commits is capped at 30 req/min authenticated. Pace at
// 2.1s between calls to stay under the cap with margin (~28 req/min). On
// 403/429 (rate-limited despite pacing — happens when the token is shared)
// honor the X-RateLimit-Reset header and sleep until then.
let nextGhAllowed = 0;
async function ghSleepUntilAllowed() {
  const now = Date.now();
  if (now < nextGhAllowed) await new Promise((r) => setTimeout(r, nextGhAllowed - now));
}
async function probeGH(email) {
  if (!GH_TOKEN) return null;
  await ghSleepUntilAllowed();
  nextGhAllowed = Date.now() + 2100; // 2.1s spacing
  try {
    const res = await fetch(
      `https://api.github.com/search/commits?q=author-email:${encodeURIComponent(email)}&per_page=1`,
      {
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Accept": "application/vnd.github.cloak-preview+json",
          "Authorization": `Bearer ${GH_TOKEN}`,
          "User-Agent": "qiji-bench/1.0",
        },
      },
    );
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") || 0);
      if (reset) {
        const waitMs = Math.max(2000, reset * 1000 - Date.now() + 1000);
        console.log(`\n  GH rate-limited; sleeping ${Math.round(waitMs/1000)}s until reset`);
        nextGhAllowed = Date.now() + waitMs;
      }
      return null;
    }
    if (!res.ok) return null;
    const j = await res.json();
    const item = j.items?.[0];
    if (!item) return null;
    const login = item.author?.login || null;
    if (!login) return null;
    return { login, repoFullName: item.repository?.full_name || null };
  } catch {
    return null;
  }
}

// ---- Run ----
const t0 = Date.now();

// D (HF search by name) skipped — prior run showed 9% recall but 88%
// of "hits" were surname collisions, not the same person. Set SKIP_D=0
// to re-enable.
const SKIP_D = process.env.SKIP_D !== "0";
const dResults = leads.map((l) => ({ arxiv_id: l.arxiv_id }));
let tD = Date.now();
if (!SKIP_D) {
  console.log("\nD: HF search by author name (concurrent 4)...");
  let dIdx = 0;
  async function workerD() {
    while (dIdx < leads.length) {
      const my = dIdx++;
      const r = await probeHF(leads[my].author_name);
      dResults[my].hf = r;
      if (my % 20 === 0) process.stdout.write(`  ${my}/${leads.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, workerD));
  process.stdout.write("\n");
  tD = Date.now();
} else {
  console.log("\nD: skipped (SKIP_D=1; prior run showed 88% surname collisions)");
}

let eIdx = 0;
const eResults = leads.map((l) => ({ arxiv_id: l.arxiv_id }));
if (GH_TOKEN) {
  console.log("\nE: GitHub commit search by email (concurrent 2 — rate limit)...");
  async function workerE() {
    while (eIdx < leads.length) {
      const my = eIdx++;
      const r = await probeGH(leads[my].author_email);
      eResults[my].gh = r;
      if (my % 20 === 0) process.stdout.write(`  ${my}/${leads.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: 2 }, workerE));
  process.stdout.write("\n");
} else {
  console.log("\nE: skipped (set GITHUB_TOKEN to run; would have tried " + leads.length + " emails)");
}
const tE = Date.now();

// ---- Tally ----
const dHits = dResults.filter((r) => r.hf).length;
const eHits = eResults.filter((r) => r.gh).length;

console.log("\n=== INVERTED-LOOKUP RECALL ===");
console.log(`D (HF search by name):  ${dHits}/${leads.length} = ${Math.round(100 * dHits / leads.length)}%`);
if (GH_TOKEN) {
  console.log(`E (GH commit by email): ${eHits}/${leads.length} = ${Math.round(100 * eHits / leads.length)}%`);
}

console.log(`\n=== TIME ===`);
console.log(`D: ${tD - t0}ms total = ${((tD - t0) / leads.length).toFixed(0)}ms/lead`);
if (GH_TOKEN) console.log(`E: ${tE - tD}ms total = ${((tE - tD) / leads.length).toFixed(0)}ms/lead`);

console.log("\n=== HF SAMPLES (10) ===");
let shown = 0;
for (let i = 0; i < dResults.length && shown < 10; i++) {
  if (!dResults[i].hf) continue;
  console.log(`  ${leads[i].author_name} <${leads[i].author_email}> -> huggingface.co/${dResults[i].hf.handle}  (model: ${dResults[i].hf.modelId})`);
  shown++;
}

if (GH_TOKEN) {
  console.log("\n=== GH SAMPLES (10) ===");
  shown = 0;
  for (let i = 0; i < eResults.length && shown < 10; i++) {
    if (!eResults[i].gh) continue;
    console.log(`  ${leads[i].author_email} -> github.com/${eResults[i].gh.login}  (via ${eResults[i].gh.repoFullName})`);
    shown++;
  }
}

writeFileSync("/tmp/bench-inverted-results.json", JSON.stringify({ d: dResults, e: eResults, leads }, null, 2));
console.log(`\nFull results: /tmp/bench-inverted-results.json`);

// Backfill persons.github_users using GitHub commit-search by email.
//
// Approach validated by scripts/bench-inverted-lookup.mjs: 14% recall,
// 100% precision-by-definition (the email literally committed under
// that username, so the binding is verified).
//
// Run: GITHUB_TOKEN=$(gh auth token) node scripts/backfill-person-github.mjs
//
// Resumable: skips persons whose github_users array is already non-empty.
// Rate-limited: GitHub /search/commits caps at 30 req/min authenticated;
// we pace at one request per 2.1s (~28 req/min) with 403/429 backoff.
//
// At 4,254 persons-with-email, expect ~150 min runtime. ~595 expected
// new github_user bindings (4254 × 0.14).

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const GH_TOKEN = process.env.GITHUB_TOKEN;
if (!GH_TOKEN) {
  console.error("Need GITHUB_TOKEN. Try: GITHUB_TOKEN=$(gh auth token) node scripts/backfill-person-github.mjs");
  process.exit(1);
}

const sb = createClient(
  "https://erguqrisqtugfysofwdd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyZ3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQxNzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM",
  { auth: { persistSession: false } },
);

const CHECKPOINT = "/tmp/backfill-person-github.checkpoint.json";
const checkpoint = existsSync(CHECKPOINT) ? JSON.parse(readFileSync(CHECKPOINT, "utf8")) : { processed: [] };
const processedSet = new Set(checkpoint.processed);

console.log(`Checkpoint: ${processedSet.size} persons already processed`);

// Pull persons that have email but no github_user. Page at 1000 to fit
// Supabase's row cap.
console.log("Loading persons with email + missing github_users...");
const targets = [];
let off = 0;
while (true) {
  const { data, error } = await sb
    .from("persons")
    .select("id, emails, github_users")
    .not("emails", "eq", "{}")
    .eq("github_users", "{}")
    .order("first_seen_at", { ascending: false })
    .range(off, off + 999);
  if (error) { console.error("page fetch:", error.message); break; }
  if (!data || data.length === 0) break;
  for (const p of data) {
    if (processedSet.has(p.id)) continue;
    targets.push(p);
  }
  if (data.length < 1000) break;
  off += data.length;
}
console.log(`To process: ${targets.length} persons`);

// Pacing
let nextAllowed = 0;
async function pacedFetch(url) {
  const now = Date.now();
  if (now < nextAllowed) await new Promise((r) => setTimeout(r, nextAllowed - now));
  nextAllowed = Date.now() + 2100;
  return fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      "Accept": "application/vnd.github.cloak-preview+json",
      "Authorization": `Bearer ${GH_TOKEN}`,
      "User-Agent": "qiji-backfill/1.0",
    },
  });
}

async function probeOne(email) {
  try {
    const res = await pacedFetch(
      `https://api.github.com/search/commits?q=author-email:${encodeURIComponent(email)}&per_page=1`,
    );
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") || 0);
      const waitMs = reset ? Math.max(2000, reset * 1000 - Date.now() + 1000) : 60000;
      console.log(`  rate-limited; sleeping ${Math.round(waitMs/1000)}s`);
      nextAllowed = Date.now() + waitMs;
      return null;
    }
    if (!res.ok) return null;
    const j = await res.json();
    const item = j.items?.[0];
    const login = item?.author?.login;
    if (!login) return null;
    return { login: String(login), via_repo: item?.repository?.full_name ?? null };
  } catch (err) {
    console.error(`  fetch error for ${email}:`, String(err).slice(0, 100));
    return null;
  }
}

// Save checkpoint every 25 persons
function saveCheckpoint() {
  writeFileSync(CHECKPOINT, JSON.stringify({ processed: [...processedSet] }, null, 2));
}

let hits = 0, misses = 0, errors = 0;
const t0 = Date.now();
for (let i = 0; i < targets.length; i++) {
  const p = targets[i];
  // For each person, try the FIRST email only — most have one anyway.
  // If we wanted higher recall we could try all of them, but that
  // doubles the rate-limit budget for marginal gain.
  const email = (p.emails || [])[0];
  if (!email) { processedSet.add(p.id); continue; }

  const result = await probeOne(email);
  processedSet.add(p.id);

  if (result) {
    // Write the github_user. Confidence is implicit-100% (email-binding
    // is by definition the same person), so direct write to persons.
    const { error } = await sb
      .from("persons")
      .update({ github_users: [result.login], last_seen_at: new Date().toISOString() })
      .eq("id", p.id);
    if (error) {
      errors++;
      console.error(`  write fail for ${p.id}:`, error.message);
    } else {
      hits++;
      console.log(`  ✓ ${email} → github.com/${result.login}  (via ${result.via_repo})`);
    }
  } else {
    misses++;
  }

  if ((i + 1) % 25 === 0) {
    saveCheckpoint();
    const rate = (i + 1) / ((Date.now() - t0) / 1000);
    const remaining = (targets.length - i - 1) / rate;
    console.log(`[${i+1}/${targets.length}] hits=${hits} misses=${misses} errors=${errors}  ETA ${Math.round(remaining/60)}m`);
  }
}
saveCheckpoint();

console.log(`\nDONE: ${hits} GitHub bindings written, ${misses} no-match, ${errors} write errors`);
console.log(`Total time: ${Math.round((Date.now() - t0) / 60000)}m`);

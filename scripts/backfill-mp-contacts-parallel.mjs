// Parallel MP backfill — N concurrent workers each draining the email
// queue. Same per-call cost (~5s round-trip to MP) but N-fold speedup
// because MP doesn't throttle us at 5 rps.
//
// Usage: node scripts/backfill-mp-contacts-parallel.mjs [WORKERS=5] [SKIP_EXISTING=true]

import { readFileSync } from "node:fs";

const envFile = readFileSync(".env.local", "utf8");
for (const line of envFile.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z_0-9]*)="?(.*?)"?$/);
  if (m) process.env[m[1]] = m[2];
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MP_BASE = (process.env.MP_API_BASE ?? "").replace(/\/+$/, "");
const MP_TOKEN = process.env.MP_API_TOKEN;
if (!SUPABASE_URL || !SUPABASE_KEY || !MP_BASE || !MP_TOKEN) { console.error("Missing env"); process.exit(2); }

const WORKERS = parseInt(process.argv[2] ?? "5");
const SKIP_EXISTING = (process.argv[3] ?? "true") !== "false";
const REACHABLE = ["delivered", "clicked", "sent", "replied", "opened"];
const TIMEOUT_MS = 20_000;

// ── Step 1: pull recipients
console.log(`[1/3] pulling distinct recipients (skipExisting=${SKIP_EXISTING}, workers=${WORKERS})...`);
const all = new Set();
let cursor = 0;
while (cursor < 100_000) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/emails?select=to&status=in.(${REACHABLE.join(",")})&order=created_at.asc&limit=1000&offset=${cursor}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  );
  const data = await r.json();
  if (!Array.isArray(data) || data.length === 0) break;
  for (const e of data) {
    if (e.to && typeof e.to === "string" && e.to.includes("@")) all.add(e.to.trim().toLowerCase());
  }
  if (data.length < 1000) break;
  cursor += 1000;
}
console.log(`    ${all.size} distinct emails`);

// ── Step 1b: skip emails already mirrored (saves work on rerun)
let queue = Array.from(all);
if (SKIP_EXISTING) {
  console.log(`[1b] checking which emails already in miracleplus_contacts...`);
  const seen = new Set();
  let off = 0;
  while (off < 100_000) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/miracleplus_contacts?select=email_canonical&order=email_canonical.asc&limit=1000&offset=${off}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) break;
    for (const c of data) if (c.email_canonical) seen.add(c.email_canonical);
    if (data.length < 1000) break;
    off += 1000;
  }
  queue = queue.filter((e) => !seen.has(e));
  console.log(`    ${seen.size} already mirrored; ${queue.length} new to check`);
}

// ── Step 2: parallel workers
console.log(`[2/3] querying MP across ${WORKERS} workers (ETA ~${Math.ceil(queue.length * 5 / WORKERS / 60)} min)...`);

function canonicalEmail(email) {
  if (!email || typeof email !== "string") return null;
  const t = email.trim().toLowerCase();
  if (!t.includes("@") || t.replace(/\*/g, "").length === 0) return null;
  return t;
}

async function mpSearch(email) {
  try {
    const res = await fetch(
      `${MP_BASE}/open_api/v1/contacts/search?q=${encodeURIComponent(email)}&per=10`,
      { headers: { Authorization: `Bearer ${MP_TOKEN}`, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) return { error: `http ${res.status}`, contacts: [] };
    const json = await res.json().catch(() => null);
    if (!json || json.code !== 0) return { error: `code ${json?.code}`, contacts: [] };
    return { contacts: json.data?.contacts ?? [] };
  } catch (err) {
    return { error: String(err).slice(0, 100), contacts: [] };
  }
}

async function upsert(contacts, queriedEmail) {
  const rows = contacts.map((c) => ({
    mp_id: c.id,
    email: typeof c.email === "string" ? c.email : null,
    email_canonical: canonicalEmail(typeof c.email === "string" ? c.email : null) ?? queriedEmail,
    name: c.name ?? null, phone: c.phone ?? null,
    application_progress: c.application_progress ?? null, application_stage: c.application_stage ?? null,
    applications_number: typeof c.applications_number === "number" ? c.applications_number : null,
    submitted_at: c.submitted_at ?? null, created_application_at: c.created_application_at ?? null,
    project: c.project ?? null, s_product: c.s_product ?? null,
    s_channel: c.s_channel ?? null, utm_source: c.utm_source ?? null,
    raw: c, last_seen_at: new Date().toISOString(),
  }));
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/miracleplus_contacts?on_conflict=mp_id`,
    { method: "POST", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(rows) },
  );
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 150)}` };
  return {};
}

const t0 = Date.now();
let checked = 0, matched = 0, apiErrors = 0, upsertErrors = 0;
let nextIdx = 0;

async function worker(id) {
  while (true) {
    const idx = nextIdx++;
    if (idx >= queue.length) return;
    const email = queue[idx];
    const { contacts, error } = await mpSearch(email);
    checked++;
    if (error) apiErrors++;
    else if (contacts.length > 0) {
      matched++;
      const { error: u } = await upsert(contacts, email);
      if (u) {
        upsertErrors++;
        if (upsertErrors <= 3) console.error(`  upsert err ${email}: ${u}`);
      }
    }
    if (checked % 50 === 0) {
      const pct = ((checked / queue.length) * 100).toFixed(0);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = (checked / Math.max(1, (Date.now() - t0) / 1000)).toFixed(1);
      process.stdout.write(`    ${checked}/${queue.length} (${pct}%) matched=${matched} apiErr=${apiErrors} upErr=${upsertErrors} elapsed=${elapsed}s rate=${rate}/s\n`);
    }
  }
}

await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));

const ms = Date.now() - t0;
console.log(`\n[3/3] DONE. checked=${checked} matched=${matched} apiErr=${apiErrors} upErr=${upsertErrors} elapsed=${(ms / 1000).toFixed(0)}s`);

// final mirror state
const r2 = await fetch(
  `${SUPABASE_URL}/rest/v1/miracleplus_contacts?select=mp_id&limit=1`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: "count=exact" } },
);
console.log(`mirror rows total: ${r2.headers.get("content-range")?.split("/")[1]}`);

const r3 = await fetch(
  `${SUPABASE_URL}/rest/v1/miracleplus_contacts?select=application_progress,applications_number,submitted_at`,
  { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
);
const allMp = await r3.json();
const buckets = { unregistered: 0, registered: 0, submitted: 0 };
for (const c of allMp) {
  const prog = (c.application_progress ?? "").toLowerCase();
  const isSubmitted = prog.includes("submitted") || (c.applications_number ?? 0) > 0 || !!c.submitted_at;
  if (isSubmitted) buckets.submitted++;
  else if (prog.includes("未注册") || prog === "" || !c.application_progress) buckets.unregistered++;
  else buckets.registered++;
}
console.log("breakdown:", buckets);
